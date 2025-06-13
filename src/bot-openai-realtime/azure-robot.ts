import { OpenAIRealtimeWebSocket } from "openai/beta/realtime/websocket";
import type { ConversationItem, RealtimeClientEvent } from "openai/resources/beta/realtime/realtime";
import type { RemotePlayer } from "@workadventure/iframe-api-typings/play/src/front/Api/Iframe/Players/RemotePlayer";
import { z, type ZodObject } from "zod";
import { extendZodWithOpenApi, generateSchema } from "@anatine/zod-openapi";
import type { Subscription } from "rxjs";
import type { OpenAiRealtimeBotMetadata, WaScriptMetadata } from "../WaScriptMetadata";
import type { ZodRawShape } from "zod/dist/types";
import type { RemotePlayerInterface } from "@workadventure/iframe-api-typings";
import { generatePlacesPrompt } from "./placesPrompt";
import { findMapEditorPlaces } from "../bot-common/places";
import { leadTo } from "../bot-common/leadTo";
import { moveToArea } from "../bot-common/moveToArea";
import { generatePeopleByPlacesPrompt, generatePeopleByRolePrompt } from "../bot-common/people";
import { moveToPlayer } from "../bot-common/moveToPlayer";
import { RealtimeUtils } from "@openai/realtime-api-beta";
import { movementManager } from "../bot-common/moveInstruction";

// TODO: REMOVE ALL THIS when types are published
/* eslint-disable */

extendZodWithOpenApi(z);

interface ToolsDefinition {
    type: "function";
    name: string;
    description: string;
    parameters: any;
}
interface Tools {
    definition: ToolsDefinition;
    callback: Function;
}

class AzureRobot {
    private mode: "waiting" | "chatting" | "disconnected" = "disconnected";
    private azureClient!: OpenAIRealtimeWebSocket;
    private usersInChat: RemotePlayer[] = [];
    //private lock: Promise<void> = Promise.resolve();
    //    private chatManager!: ChatManager;
    //    private movementManager!: ChatManager;
    // The number of successive noOp calls.
    private noOpCounter = 0;
    // The number of noOp calls after which we listen to the chat less frequently.
    private noOpDisableListeningThreshold = 2;
    private noOpDisableListeningMode = false;
    private nbSkippedMessages = 0;
    // When in "listening disabled mode", we still trigger GPT every 10 messages, to make sure we don't miss anything.
    private nbMessagesToSkipInDisableListeningMode = 10;
    private botMetadata!: OpenAiRealtimeBotMetadata;
    private inactivityTimer: NodeJS.Timeout | null = null;
    private sessionTimer: NodeJS.Timeout | null = null;
    private messageUser: NodeJS.Timeout | null = null;
    private readonly inactivityTimeout = 5 * 1000; // 15 seconds
    private sessionTimeout = 15 * 60 * 1000; // 15 minutes
    // TODO: REMOVE ALL THIS when types are published
    //@ts-ignore
    private audioStream: AudioStream | undefined = undefined;
    private tools: Record<string, Tools> = {};
    private isWebsocketOpen: boolean = false;

    /**
     * @param chatHistorySummaryNbWords When summarizing the chat history, let's make a summary of this many number of words.
     */
    constructor(private chatHistorySummaryNbWords = 200, private audioTranscriptionModel: "whisper-1" = "whisper-1") {}

    async init(metadata: WaScriptMetadata) {
        console.log("Robot is starting...");

        if (!("type" in metadata.bots)) {
            throw new Error("This script can only be executed by LLM bots.");
        }

        if (metadata.bots.type !== "realtime") {
            throw new Error("This script can only be executed by OpenAI bots.");
        }

        this.botMetadata = metadata.bots;

        if (this.botMetadata.realtime.llmEnableMoveInstructions) {
            movementManager.initMovementManager(metadata, "gpt-4o-mini");
        }

        let listenToAudioStreamSubscription: Subscription | undefined = undefined;

        WA.player.proximityMeeting.onJoin().subscribe((users) => {
            (async () => {
                if (!this.azureClient || this.azureClient.socket.readyState > 1) {
                    await this.initAzureOpenAI();
                } else if (this.azureClient.socket.readyState === 1) {
                    this.azureClient.send({
                        type: "session.update",
                        session: {
                            modalities: ["text", "audio"],
                        },
                    });
                }

                this.mode = "chatting";
                this.usersInChat = users;

                this.resetInactivityTimer();

                // TODO: REMOVE ALL THIS when types are published
                // @ts-ignore
                this.audioStream = await WA.player.proximityMeeting.startAudioStream(24000);

                const audioBuffer = new Float32Array(24000 * 0.05);
                let bufferIndex = 0;

                // TODO: REMOVE ALL THIS when types are published
                // @ts-ignore
                listenToAudioStreamSubscription = WA.player.proximityMeeting
                    // @ts-ignore
                    .listenToAudioStream(24000)
                    .subscribe((data: Float32Array) => {
                        //console.log('AudioStream received', data);

                        if (bufferIndex + data.length > audioBuffer.length) {
                            audioBuffer.set(data.subarray(0, audioBuffer.length - bufferIndex), bufferIndex);
                            this.sendOpenaiEvents([
                                {
                                    type: "input_audio_buffer.append",
                                    audio: RealtimeUtils.arrayBufferToBase64(audioBuffer),
                                },
                            ]);
                            bufferIndex = 0;
                            audioBuffer.set(data.subarray(audioBuffer.length - bufferIndex));
                        } else {
                            audioBuffer.set(data, bufferIndex);
                            bufferIndex += data.length;
                        }
                    });

                this.startChat(users).catch((e) => {
                    this.handleError(e);
                });

                // Send an item and triggers a generation
                //this.realtimeClient.sendUserMessageContent([{type: 'input_text', text: `How are you?`}]);
            })().catch((e) => {
                this.handleError(e);
            });
        });

        WA.player.proximityMeeting.onLeave().subscribe(() => {
            this.audioStream?.close();
            listenToAudioStreamSubscription?.unsubscribe();

            if (this.azureClient && this.azureClient.socket.readyState === 1) {
                this.azureClient.send({
                    type: "session.update",
                    session: {
                        modalities: ["text"],
                    },
                });
            }

            this.mode = "waiting";

            const summaryPrompt =
                "You stopped chatting with " +
                this.usersList(this.usersInChat, true) +
                ".\n\n" +
                "If you learned anything meaningful that you want to remember, please call the saveSummary function with the summary of the conversation. Do not generate any voice output. Simply call the saveSummary function.";
            //const chatPrompt = await getChatPrompt(users, summary);

            this.usersInChat = [];

            this.addSystemMessage(summaryPrompt);

            this.startInactivityTimer();
        });

        //
        //         this.resetMovementManager();
        //
        //         WA.players.onVariableChange("currentPlace").subscribe(() => {
        //             if (this.mode === "waiting") {
        //                 this.throttledMovePrompt();
        //             }
        //         });
        //
        //
        WA.player.proximityMeeting.onParticipantJoin().subscribe((user) => {
            (async () => {
                await this.newUserJoinedConversation(user);
            })().catch((e) => {
                this.handleError(e);
            });

            // this.recomputeChatPrompt();
            // this.chatManager.executeWhenReady(async () => {
            //     this.remotePlayerJoined(user);
            //     return Promise.resolve();
            // });
        });
        //
        //         WA.player.proximityMeeting.onLeave().subscribe(() => {
        //             (async () => {
        //                 // When we leave a proximity meeting, we stop chatting
        //                 this.mode = "waiting";
        //
        //                 await this.saveChat(this.usersInChat);
        //
        //                 this.usersInChat = [];
        //             })().catch((e) => {
        //                 this.handleError(e);
        //             });
        //         });
        //
        WA.player.proximityMeeting.onParticipantLeave().subscribe((user) => {
            try {
                this.userLeftConversation(user);
            } catch (e) {
                this.handleError(e);
            }
            //            this.recomputeChatPrompt();
        });

        WA.chat.onChatMessage(
            (message, event) => {
                if (this.mode !== "chatting") {
                    console.warn("Received a chat message while not in chatting mode: ", message, event);
                    return;
                }

                //eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
                if (!event.author) {
                    console.warn("Received a chat message without author: ", message, event);
                    // We are receiving our own message, let's ignore it.
                    return;
                }

                this.addUserMessage(message, event.author);
            },
            {
                scope: "bubble",
            }
        );
        //
        WA.event.on("summon").subscribe((event) => {
            const Position = z.object({
                x: z.number(),
                y: z.number(),
            });

            const position = Position.parse(event.data);
            // TODO: the bot could be more polite and say goodbye if it was in a conversation
            WA.player.moveTo(position.x, position.y).catch((e) => {
                this.handleError(e);
            });
        });

    
    }

    private async initAzureOpenAI(): Promise<void> {
        this.tools = {};
        console.log("tools", this.tools);
        // Don't forget to implement dynamic model if used
        // const openAIClient = new OpenAI({
        //     apiKey: WA.room.hashParameters.openaiApiKey,
        //     baseURL: "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
        //     dangerouslyAllowBrowser: true,
        // });
        //
        // this.azureClient = new OpenAIRealtimeWebSocket(
        //     {
        //         model: "gpt-4o-realtime-preview-2024-12-17",
        //         dangerouslyAllowBrowser: true,
        //     },
        //     openAIClient
        // );

    

        this.azureClient = new OpenAIRealtimeWebSocket({ model: 'gpt-4o-realtime-preview-2024-12-17' })
    

        console.log("this.azureClient", this.azureClient);

        this.azureClient.socket.addEventListener("error", (err) => {
            console.error("WebSocket Error:", err);
        });

        this.azureClient.socket.onopen = async () => {
            this.isWebsocketOpen = true;
            this.sessionTimeout = this.botMetadata.realtime.sessionTimeout * 60 * 1000;
            this.startSessionTimer();

            console.log("Websocket opened");

            this.azureClient.send({
                type: "session.update",
                session: {
                    instructions:
                        this.botMetadata.realtime.llmChatInstructions +
                        `\n\nWhen text messages are sent to you, they will be sent with a prefix. [System] means the message comes from the system. Those messages describe what happens in the world and how you should behave. [User: some_user_name] means the message comes from a user.` +
                        "\n\n" +
                        (await generatePlacesPrompt()),
                },
            });

            this.azureClient.send({
                type: "session.update",
                session: {
                    voice: this.botMetadata.realtime.voice,
                },
            });
            this.azureClient.send({
                type: "session.update",
                session: {
                    turn_detection: {
                        type: "server_vad",
                        threshold: 0.5, // 0.0 to 1.0,
                        prefix_padding_ms: 300, // How much audio to include in the audio stream before the speech starts.
                        silence_duration_ms: 300, // How long to wait to mark the speech as stopped.
                    },
                    input_audio_transcription: { model: this.audioTranscriptionModel },
                },
            });
        };

        this.azureClient.on("session.updated", (e) => {
            console.log("session updated", e);
        });
        this.azureClient.socket.onclose = () => {
            this.isWebsocketOpen = false;
            console.log("Websocket closed");
        };

        // TODO: REMOVE ALL THIS when types are published
        // eslint-disable-next-line
        // @ts-ignore
        this.azureClient.on("input_audio_buffer.speech_started", (event) => {
            // Let's remove the parts from the conversation that have not been played yet.
            this.azureClient.send({
                type: "response.cancel",
            });
            if (lastAudioMessageItemIdPlayed) {
                if (audioSampleCounter < audioSampleCounterPlayed) {
                    this.azureClient.send({
                        type: "conversation.item.truncate",
                        item_id: lastAudioMessageItemIdPlayed,
                        content_index: 0,
                        audio_end_ms: Math.floor(audioSampleCounterPlayed / 24), // divide by default frequency khz
                    });
                    console.warn(
                        "Interrupted conversation, cancelling response",
                        lastAudioMessageItemIdPlayed,
                        audioSampleCounterPlayed,
                        "of",
                        audioSampleCounter
                    );
                }
            }

            // TODO: REMOVE ALL THIS when types are published
            // eslint-disable-next-line
            this.audioStream?.resetAudioBuffer().catch((e: unknown) => {
                this.handleError(e);
            });
        });

        // TODO: REMOVE ALL THIS when types are published
        // eslint-disable-next-line
        // @ts-ignore
        this.azureClient.on("error", (event) => {
            console.error("Realtime API error received from OpenAI server", event);
            
            // Let's send a message to the chat
            /*WA.chat.sendChatMessage(`An error occurred: ${error.type} - code: ${error.code} - message: ${error.message}`, {
                scope: "bubble",
            });*/
        });

        this.azureClient.on("response.done", (event) => {
            if (event && event.response && event.response.output && event?.response?.output[0]?.content) {
                const message =
                    event?.response?.output[0]?.content[0]?.text ??
                    event?.response?.output[0]?.content[0]?.transcript ??
                    "";
                console.log("Response done.", message, "Usage: ", event?.response?.usage);
                
            }
        });

        let lastAudioMessageItemId: string = "";
        let audioSampleCounter = 0;
        let lastAudioMessageItemIdPlayed = "";
        let audioSampleCounterPlayed = 0;

        this.azureClient.on("response.audio.delta", (event) => {
            console.log("audio delta", event);
            if (event.item_id !== lastAudioMessageItemId) {
                console.log("itemid reset", audioSampleCounter, lastAudioMessageItemId);
                audioSampleCounter = 0;
                lastAudioMessageItemId = event.item_id;
            }

            // console.log("event.delta", this.audioStream);
            if (this.audioStream) {
                const base64audio = event.delta;
                const arrayBuffer = RealtimeUtils.base64ToArrayBuffer(base64audio);
                const appendValues = new Int16Array(arrayBuffer);
                let int16Array = new Int16Array(0);
                int16Array = RealtimeUtils.mergeInt16Arrays(int16Array, appendValues);
                // Convert Int16Array to Float32Array as the Web Audio API uses Float32
                const float32Array = new Float32Array(int16Array.length);
                for (let i = 0; i < int16Array.length; i++) {
                    float32Array[i] = int16Array[i] / 32768.0;
                }

                audioSampleCounter += int16Array.length;
                const constLastAudioMessageItemId = lastAudioMessageItemId;
                const constAudioSampleCounter = audioSampleCounter;

                // TODO: REMOVE ALL THIS when types are published
                // eslint-disable-next-line
                this.audioStream
                    .appendAudioData(float32Array)
                    .then(() => {
                        lastAudioMessageItemIdPlayed = constLastAudioMessageItemId;
                        audioSampleCounterPlayed = constAudioSampleCounter;
                    })
                    .catch((e: unknown) => {
                        // Let's do nothing in case of reject. This happens when we reset the audio buffer.
                        console.log("Discarded audio data", e);
                    });
            } else {
                console.error("No audio stream started");
            }
        });

        this.azureClient.on("response.output_item.done", (event) => {
            if (
                event?.item?.type === "message" &&
                event?.item?.status === "completed" &&
                event?.item?.role === "assistant" &&
                event?.item?.content
            ) {
                console.log("Assistant response", event.item.content);
                // Let's send the response to the chat
                for (const content of event.item.content) {
                    if (content.type === "text") {
                        WA.chat.sendChatMessage(content.text || "", {
                            scope: "bubble",
                        });
                    }
                }
            }
        });

        this.azureClient.on("response.output_item.done", (event) => {
            console.log("response output item done", event);

            if (
                event?.item &&
                event?.item?.type === "function_call" &&
                event?.item?.status === "completed" &&
                event?.item?.name
            ) {
                console.log("Function call", event.item.name);
                this.callTool(event.item);
            }
        });

       

        this.addTool(
            "getPlaces",
            "Retrieve the detail of places on this map. You will be provided with a list of places you can go to and their descriptions.",
            z.object({
                filter: z.string().openapi({
                    description:
                        "If empty, returns all places. If not empty, returns only the places that contain the filter in their name.",
                }),
            }),
            async (args) => {
                console.warn("Calling getPlaces tool with parameter", args);
                const places = await findMapEditorPlaces(args.filter);
                console.warn("Found places", places);
                let response = "";

                for (const [name, description] of places.entries()) {
                    if (name) {
                        response += `- ${name}: ${description}\n`;
                    }
                }
                return response;
            }
        );

        this.addTool(
            "goToPlace",
            "Move your character to any place on the map.",
            z.object({
                destination: z.string().openapi({
                    description: "The name of the place you want to move to.",
                }),
                leadUsers: z.boolean().optional().openapi({
                    description:
                        "If true, will move all users in the chat with you to the destination. If false, you will go alone to the destination and the chat will be interrupted.",
                }),
            }),
            async (args) => {
                console.warn("Calling goToPlace tool with parameter", args);
                if (args.leadUsers) {
                    await leadTo(args.destination);
                } else {
                    await moveToArea(args.destination);
                }
                return "You are now in " + args.destination;
            }
        );

        this.addTool(
            "goToUser",
            "Go and talk to another user. This will move your character next to the user you want to talk to, possibly interrupting the current conversation.",
            z.object({
                userName: z.string().openapi({
                    description: "The name of the user you want to go to.",
                }),
                /*leadUsers: z.boolean().optional().openapi({
                    description: "If true, will move all users in the chat with you to the destination. If false, you will go alone to the destination and the chat will be interrupted.",
                }),*/
            }),
            async (args) => {
                console.warn("Calling goToUser tool with parameter", args);

                const players = WA.players.list();
                for (const player of players) {
                    if (player.name.toLowerCase() === args.userName.toLowerCase()) {
                        await moveToPlayer(player.playerId);
                        return "You are now next to " + args.userName;
                    }
                }
                return "Could not find a user named " + args.userName;
            }
        );

        this.addTool(
            "getUsersInMap",
            "Returns a list of users in the map at this very moment with their position. This list includes all users, not only the coworkers and not only the ones you are chatting with.",
            z.object({}),
            () => {
                return generatePeopleByPlacesPrompt() + "\n" + generatePeopleByRolePrompt();
            }
        );

        this.addTool(
            "saveSummary",
            "Save a summary of the conversation you had with the users you were just chatting with. Call this function when a conversation is over if you learned anything meaningful that you want to remember. I will pass you back the summary you saved whenever you meet the participants again.",
            z.object({
                summary: z.string().openapi({
                    description: "The summary of the conversation.",
                }),
                users: z.array(z.string()).openapi({
                    description: "The IDs of the users you were chatting with.",
                }),
            }),
            async (args) => {
                console.log("Saving summary", args);
                try {
            
                    return "Summary saved. No need to say anything to the user.";
                } catch (e: unknown) {
                    console.error(e);
                    throw e;
                }
            }
        );
    }

    private sendOpenaiEvents(events: RealtimeClientEvent[]) {
        if (this.azureClient.socket.readyState === 1) {
            events.map((event) => {
                this.azureClient.send(event);
            });
        } else {
            let that = this;
            setTimeout(() => {
                that.sendOpenaiEvents(events);
            }, 1000);
        }
    }

    private usersList(users: RemotePlayer[], withIds = false): string {
        const formatter = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

        return formatter.format(users.map((user) => user.name + (withIds ? ` (ID: "${user.uuid}")` : "")));
    }

    private async startChat(users: RemotePlayer[]) {
        //await this.resetChatManager();

        const chatPrompt =
            "You are currently chatting with " +
            this.usersList(users) +
            ".\n\n" +
            (await this.loadChat(users)) +
            "\n\nYou start first. Please engage the conversation with a short welcome message. If you already met the user, don't hesitate to ask them how they are doing and make reference to past conversations you had.";
        //const chatPrompt = await getChatPrompt(users, summary);

        this.addSystemMessage(chatPrompt);
    }

    private async newUserJoinedConversation(user: RemotePlayer) {
        this.usersInChat.push(user);

        const chatPrompt =
            "A new user, " +
            user.name +
            ", has joined the conversation. Please welcome them.\n\n" +
            (await this.loadChat([user])) +
            "\n\nYou are now in chat with " +
            this.usersList(this.usersInChat) +
            ".\n\n";

        this.addSystemMessage(chatPrompt);
    }

    private userLeftConversation(user: RemotePlayer) {
        this.usersInChat = this.usersInChat.filter((theUser) => user.playerId !== theUser.playerId);
        const chatPrompt =
            "User " +
            user.name +
            " has left the conversation.\n\n" +
            "You are now in chat with " +
            this.usersList(this.usersInChat) +
            ".\n\n";

        this.addSystemMessage(chatPrompt);
    }

    private addSystemMessage(message: string): void {
        console.log("Sending system message: ", message);
        this.sendOpenaiEvents([
            {
                type: "conversation.item.create",
                item: {
                    type: "message",
                    role: "system",
                    content: [
                        {
                            type: "input_text",
                            text: message,
                        },
                    ],
                },
            },
            {
                type: "response.create",
                response: undefined,
            },
        ]);
    }

    public addUserMessage(content: string, player: RemotePlayerInterface) {
        console.log("Sending user message: ", content);
        this.sendOpenaiEvents([
            {
                type: "conversation.item.create",
                item: {
                    type: "message",
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: "[User " + player.name + "]:" + content,
                        },
                    ],
                },
            },
            {
                type: "response.create",
                response: undefined,
            },
        ]);
    }
    //
    //     /**
    //      * Sends a chat message both audio and text.
    //      */
    //     private async sendChatMessage(response: string): Promise<void> {
    //         this.noOpCounter = 0;
    //         this.noOpDisableListeningMode = false;
    //         if (!("type" in this.metadata.bots)) {
    //             throw new Error("This script can only be executed by Tock bots.");
    //         }
    //         //eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
    //         WA.chat.sendChatMessage(response, {
    //             scope: "bubble",
    //         });
    //         if (this.metadata.bots.type === "openai") {
    //             const soundResponse = await this.realtimeClient.audio.speech.create({
    //                 model: "tts-1",
    //                 input: response,
    //                 voice: this.metadata.bots.openai.voice,
    //                 response_format: "opus",
    //             });
    //             const blob = await soundResponse.blob();
    //             const dataUrl = (await this.readBlob(blob)) as string;
    //             //eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
    //             await WA.player.proximityMeeting.playSound(dataUrl);
    //         }
    //         return;
    //     }
    //
    //     private readBlob(b: Blob) {
    //         return new Promise(function (resolve, reject) {
    //             const reader = new FileReader();
    //
    //             reader.onloadend = function () {
    //                 resolve(reader.result);
    //             };
    //
    //             reader.onerror = reject;
    //
    //             reader.readAsDataURL(b);
    //         });
    //     }
    //
    //     private remotePlayerJoined(user: RemotePlayer) {
    //         // TODO: properly throttle this by adding players joining to a queue
    //         if (this.mode === "chatting") {
    //             this.chatManager.addSystemMessage(userJoinedChat(user));
    //         }
    //     }
    //
    //     private async saveChat(usersInChat: RemotePlayer[]) {
    //         // Users who actually said something in the chat
    //         const playerUuids = this.chatManager.getParticipantsUuid();
    //
    //         if (playerUuids.length > 0) {
    //             const summary = await this.chatManager.summarizeChatHistory(200);
    //
    //             await saveSummary(summary, Array.from(playerUuids));
    //         } else {
    //             // If no one talked, we save that the user(s) did not say anything.
    //             await saveSummary(
    //                 undefined,
    //                 usersInChat.map((user) => user.uuid)
    //             );
    //         }
    //
    //         /*const now = new Date();
    //         for (const uuid of playerUuids) {
    //             // Let's save the summary in local storage, along the date of the chat
    //             // TODO: move this to a server-side storage, because all variables are loaded in the iframe on startup!
    //
    //             const key = `chat-summary-${uuid}`;
    //             const existingSummary = WA.player.state[key] as any ?? [];
    //             existingSummary.push({
    //                 date: now.toISOString(),
    //                 summary,
    //             });
    //             await WA.player.state.saveVariable(key, existingSummary, {
    //                 persist: true,
    //                 public: false,
    //             });
    //         }*/
    //     }
    //

    private async loadChat(users: RemotePlayer[]) {
        const summaries = 
            10
            true;

        let content: string = "";

        for (const user of users) {
            const summariesPerUser = 10;
            
        }

        return content;
        /*let content: string = "";
        for (const user of users) {
            content += this.loadChatForOneUser(user);
        }
        return content;*/
    }
    //
    //     /*private loadChatForOneUser(user: RemotePlayer): string {
    //         const key = `chat-summary-${user.uuid}`;
    //         const summaries = WA.player.state[key] as any;
    //         if (!summaries) {
    //             return `You are meeting ${user.name} for the first time.`
    //         }
    //         const now = new Date();
    //         let content = "";
    //         for (const summary of summaries) {
    //             content += `On ${now.toLocaleDateString('en-us', { weekday:"long", year:"numeric", month:"short", day:"numeric"}) }, at ${now.toLocaleTimeString('en-us', { hour: "2-digit", minute: "2-digit"  })}, you had the following conversation with ${user.name}:\n${summary.summary}\n\n`;
    //         }
    //         return content;
    //     }*/

    private handleError(e: unknown) {
        console.error(e);
        WA.chat.sendChatMessage("Beep bop... Sorry, I'm currently facing issues.", {
            scope: "bubble",
        });
    }

    private addTool<T extends ZodRawShape>(
        name: string,
        description: string,
        parameters: ZodObject<T>,
        callback: (args: z.infer<ZodObject<T>>) => Promise<string> | string
    ): void {
        console.log("Adding tool", name, description, parameters);
        // TODO check if tools already exist and give tool list in session update
        if (!this.tools[name]) {
            this.tools[name] = {
                definition: {
                    type: "function",
                    name: name,
                    description: description,
                    parameters: generateSchema(parameters) as { [key: string]: unknown },
                },
                callback: async (args: z.infer<ZodObject<T>>) => {
                    try {
                        console.log("Calling tool", name, "with parameters", args);
                        const response = await callback(args);
                        console.log("Tool", name, "returned:", response);
                        return response;
                    } catch (e: unknown) {
                        this.handleError(e);
                        return "An error occurred";
                    }
                },
            };
            // console.log("tools list", this.tools);
            this.sendTools();
        } else {
            console.warn("Tool", name, "already exists. Skipping.");
        }
    }

    private async callTool(tool: ConversationItem): Promise<void> {
        try {
            const jsonArguments = JSON.parse(tool.arguments || "");
            const toolConfig = this.tools[tool.name || ""];
            if (!toolConfig) {
                console.error("Tool not found", tool.name);
            }
            const result = await toolConfig.callback(jsonArguments);
            this.azureClient.send({
                type: "conversation.item.create",
                item: {
                    type: "function_call_output",
                    call_id: tool.call_id,
                    output: JSON.stringify(result),
                },
            });
        } catch (e) {
            this.azureClient.send({
                type: "conversation.item.create",
                item: {
                    type: "function_call_output",
                    call_id: tool.call_id,
                    output: JSON.stringify({ error: e }),
                },
            });
        }

        this.azureClient.send({
            type: "response.create",
            response: undefined,
        });
    }

    private sendTools() {
        let toolsDefinition: ToolsDefinition[] = [];
        for (const tool in this.tools) {
            toolsDefinition.push(this.tools[tool].definition);
        }

        console.log("Sending tools", this.azureClient);

        this.sendOpenaiEvents([
            {
                type: "session.update",
                session: {
                    tools: toolsDefinition,
                },
            },
        ]);
    }

    private resetInactivityTimer() {
        if (this.inactivityTimer) {
            clearTimeout(this.inactivityTimer);
        }
    }

    private startInactivityTimer() {
        this.inactivityTimer = setTimeout(() => {
            this.shutdownBot();
        }, this.inactivityTimeout);
    }
    private startSessionTimer() {
        this.sessionTimer = setTimeout(async () => {
            WA.chat.sendChatMessage("The session is over, a new one restarted.", {
                scope: "bubble",
            });
            await this.initAzureOpenAI();
        }, this.sessionTimeout);
        this.messageUser = setTimeout(async () => {
            WA.chat.sendChatMessage("This session will end in 30 seconds.", {
                scope: "bubble",
            });
        }, this.sessionTimeout - 30 * 1000);
    }

    private shutdownBot() {
        this.sessionTimer = null;
        this.messageUser = null;
        this.azureClient.close();
        this.mode = "disconnected";
    }
}

export const azureRobot = new AzureRobot();
