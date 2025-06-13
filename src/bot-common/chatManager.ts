import { Subject } from "rxjs";
import type OpenAI from "openai";
import type { z, ZodObject } from "zod";
import type { ZodRawShape } from "zod/dist/types";
import { generateSchema } from "@anatine/zod-openapi";
import type { FunctionParameters } from "openai/resources/shared";
import wordsCount from "words-count";
import type { RemotePlayerInterface } from "@workadventure/iframe-api-typings";
import type {
    ChatCompletionAssistantMessageParam,
    ChatCompletionSystemMessageParam,
    ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";

import type { WaScriptMetadata } from "../WaScriptMetadata";

export type Message =
    | (ChatCompletionSystemMessageParam & { callback?: (message: string) => void })
    | ChatCompletionAssistantMessageParam
    | { role: "user"; player: RemotePlayerInterface; content: string }
    | ChatCompletionToolMessageParam /*& { name: string }*/;

export class ChatManager {
    private lock: Promise<string | undefined> = Promise.resolve(undefined);
    private chatHistory: Message[] = [];
    private pendingMessages: Message[] = [];
    private startTalkingSubject = new Subject<void>();
    private stopTalkingSubject = new Subject<void>();
    private answerReceivedCallback: ((message: string) => void) | undefined;
    private errorHandlerSubject = new Subject<Error>();
  
    private tools = new Map<
        string,
        {
            tool: OpenAI.Chat.ChatCompletionTool;
            callback: (args: unknown) => Promise<string>;
            synchronousResponse: boolean;
        }
    >();
    public readonly startTalking = this.startTalkingSubject.asObservable();
    public readonly stopTalking = this.stopTalkingSubject.asObservable();
    public readonly errorHandler = this.errorHandlerSubject.asObservable();
  
    private shortener: ((summary: string) => string) | undefined;
    private _prefixWithUserNames = false;
    private stopped: boolean = false;
    private forcedFunction: string | undefined;

    /**
     * @param openai Openai client.
     * @param model Model used for openai requests.
     * @param metadata Metadata.
     * @param chatHistorySummaryNbWords When summarizing the chat history, let's make a summary of this many number of words.
     * @param tokensSummaryTrigger Trigger a summary when the number of tokens in the chat history is above this number.
     * @param enableTools Decides if tools are sent to Openai.
     */
    constructor(
        private openai: OpenAI,
        private model: string,
        private metadata: WaScriptMetadata,
        private chatHistorySummaryNbWords = 200,
        private tokensSummaryTrigger = 3200,
        private enableTools: number
    ) {
        this.errorHandler.subscribe((error) => {
            console.error(error);
        });
    }

    public registerAnswerReceivedCallback(callback: (message: string) => void) {
        this.answerReceivedCallback = callback;
    }

    /**
     * Add a system message.
     * If a callback is passed, it will be called when the answer to the message is received. In this case,
     * the message output will not be displayed in the chat.
     */
    public addSystemMessage(content: string, callback?: (content: string) => void) {
        this.pendingMessages.push({
            role: "system",
            content,
            callback,
        });
        this.scheduleRun({
            triggerTypingIndicator: callback ? false : true,
            dispatchAnswer: callback ? false : true,
        }).catch((error) => this.errorHandlerSubject.next(ChatManager.toError(error)));
    }

    public addUserMessage(content: string, player: RemotePlayerInterface, scheduleRun = true) {
        this.pendingMessages.push({
            role: "user",
            player,
            content,
        });
        if (scheduleRun) {
            this.scheduleRun({
                triggerTypingIndicator: true,
                dispatchAnswer: true,
            }).catch((error) => this.errorHandlerSubject.next(ChatManager.toError(error)));
        }
    }

    /**
     * Replaces the first system message by another one.
     * Can be useful to change the context (for instance when we switch from one to many users in a conversation).
     * If no system message is here, one will be prepended.
     */
    public replaceFirstSystemMessage(content: string) {
        const message = this.chatHistory.find((message) => message.role === "system");
        if (message === undefined) {
            this.chatHistory.unshift({
                role: "system",
                content,
            });
            return;
        }
        message.content = content;
    }

    private static toError(error: unknown): Error {
        if (error instanceof Error) {
            return error;
        }
        if (typeof error === "string") {
            return new Error(error);
        }
        return new Error("Unknown error");
    }

    /**
     * Registers a function that can be called by OpenAPI chat completion API.
     * Parameters are passed as a Zod object that must be completed by an openapi description (using @anatine/zod-openapi).
     * The string returned by the callback will be sent back to OpenAPI. If undefined is returned, no response will be sent (but you will
     * not be able to send further messages as OpenAPI expects a response to be sent).
     *
     * @param synchronousResponse If true, we will call back the API as soon as the callback returns an answer. If false, we will wait for the next message to be sent to the bot.
     */
    public registerFunction<T extends ZodRawShape>(
        name: string,
        description: string,
        parameters: ZodObject<T>,
        callback: (args: z.infer<ZodObject<T>>) => Promise<string>,
        synchronousResponse = true
    ) {
        if (this.enableTools) {
            console.log("Setting tools", name);
            this.tools.set(name, {
                callback: (args: unknown) => callback(parameters.parse(args)),
                tool: {
                    type: "function",
                    function: {
                        name,
                        description,
                        parameters: generateSchema(parameters) as FunctionParameters,
                    },
                },
                synchronousResponse,
            });
        } else {
            console.log("Not setting tools:", name);
        }
    }

    private scheduleRun(options: {
        triggerTypingIndicator: boolean;
        dispatchAnswer: boolean;
    }): Promise<string | undefined> {
        return (this.lock = this.lock.then(async () => {
            if (this.stopped) {
                return;
            }

            const response = await this.run(options);
            if (options.dispatchAnswer && response) {
                if (!this.answerReceivedCallback) {
                    throw new Error("No answerReceivedCallback registered");
                }
                this.answerReceivedCallback(response);
            }
            return response;
        }));
    }

    private async run(options: { triggerTypingIndicator: boolean }): Promise<string | undefined> {
        if (this.pendingMessages.length === 0) {
            // Nothing to do.
            return;
        }

        // Let's unpack messages. We can put user messages together, but system messages must be sent one by one.
        let lastMessage: Message | undefined;
        let callback: ((message: string) => void) | undefined;

        // First of all, let's prioritize all tool calls. We need to send all the answers to the tools in priority.
        for (const pendingMessage of this.pendingMessages) {
            if (pendingMessage.role === "tool") {
                // We must insert the tool call right after the call to the tool by the assistant.
                // Let's push the tool answer right after the call to tool by the assistant.
                const index = this.chatHistory.findIndex(
                    (message) =>
                        message.role === "assistant" &&
                        message.tool_calls?.find((tool_call) => tool_call.id === pendingMessage.tool_call_id)
                );
                if (index === -1) {
                    throw new Error(
                        `Could not find tool call with ID "${pendingMessage.tool_call_id}" in chat history`
                    );
                }
                this.chatHistory.splice(index + 1, 0, pendingMessage);
            }
        }
        // Let's remove all tool messages from the pending messages.
        this.pendingMessages = this.pendingMessages.filter((message) => message.role !== "tool");

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const nextMessage = this.pendingMessages.shift();
            if (nextMessage === undefined) {
                break;
            }
            if (nextMessage.role === "system") {
                if (lastMessage) {
                    // If there was a previous message added, it is a user message. So we don't want to put a system message after.
                    this.pendingMessages.unshift(nextMessage);
                    break;
                }
                this.chatHistory.push(nextMessage);
                callback = nextMessage.callback;
                break;
            }
            this.chatHistory.push(nextMessage);
            lastMessage = nextMessage;
        }

        //this.chatHistory.push(...this.pendingMessages);
        //this.pendingMessages = [];

        const messages = this.chatHistory.map((message) => {
            if (message.role === "user") {
                return {
                    role: "user",
                    content: this._prefixWithUserNames ? message.player.name + ": " + message.content : message.content,
                } as const;
            } else if (message.role === "system") {
                return {
                    role: "system",
                    content: message.content,
                } as const;
            }
            return message;
        });

        // In some "customllm" implementations, you need at least one user message (even empty). Only one system message is not enough.
        if ("type" in this.metadata.bots && this.metadata.bots.type === "customllm") {
            if (messages.find((message) => message.role === "user") === undefined) {
                messages.push({
                    role: "user",
                    content: " ",
                });
            }
        }

        if (options.triggerTypingIndicator) {
            this.startTalkingSubject.next();
        }

        try {
            console.log("OpenAI request:", messages);
            console.log("model", this.model);
            console.log("chat", this.openai);

            const tools = Array.from(this.tools.values()).map((tool) => tool.tool);

            const chatCompletion = await this.openai.chat.completions.create({
                messages,
                // TODO: make this a constructor parametedr.
                model: this.model,
                //model: "gpt-4-1106-preview",
                //model: 'gpt-3.5-turbo',
                tools,
                tool_choice: this.forcedFunction
                    ? {
                          type: "function",
                          function: { name: this.forcedFunction },
                      }
                    : "auto",
            });


            if (this.stopped) {
                // If the bot was stopped while we were waiting for the response, we don't want to handle the response.
                return;
            }

            const responseMessage = chatCompletion.choices[0]?.message;
            if (responseMessage === null) {
                console.error("OpenAI returned no response: ", chatCompletion);
                return;
            }

            console.log("OpenAI response:", responseMessage);

            if (responseMessage?.content || responseMessage?.tool_calls) {
                /*this.chatHistory.push({
                    role: "assistant",
                    content: response,
                });*/

                this.chatHistory.push(responseMessage);
            }

            const toolCalls = responseMessage.tool_calls;
            let shouldSendAnswer = false;

            if (toolCalls) {
                for (const toolCall of toolCalls) {
                    if (toolCall.type === "function") {
                        const functionName = toolCall.function.name;
                        const tool = this.tools.get(functionName);
                        if (tool === undefined) {
                            throw new Error("Unknown tool: " + functionName);
                        }

                        const jsonArgs = toolCall.function.arguments;
                        let args;
                        try {
                            args = JSON.parse(jsonArgs) as unknown;
                        } catch (e) {
                            console.error(`Could not parse arguments for function ${functionName}: `, jsonArgs, e);
                            break;
                        }

                        const response = await tool.callback(args);

                        if (this.stopped) {
                            // If the bot was stopped while we were handling the response, let's stop right there.
                            return;
                        }

                        this.pendingMessages.unshift({
                            tool_call_id: toolCall.id,
                            role: "tool",
                            //"name": toolCall.function.name,
                            content: response,
                        });

                        if (tool.synchronousResponse) {
                            shouldSendAnswer = true;
                        }
                    }
                }

                if (shouldSendAnswer) {
                    return await this.run(options);
                }
            }

            if (callback) {
                if (!responseMessage?.content) {
                    throw new Error("No message received for callback of system message.");
                }
                callback(responseMessage?.content);
            }

            // Let's see if we need to shorten the chat history (in case we are approaching the token limit)
            const nbTokens = this.evaluateNbTokens();
            if (nbTokens > this.tokensSummaryTrigger) {
                await this.shortenChatHistory();
            }

            return responseMessage?.content ?? undefined;
        } catch (error) {
            
        }
    }

    private evaluateNbTokens(): number {
        const completeMessage = this.chatHistory.map((message) => message.content).join("\n");
        const nbWords = wordsCount(completeMessage);

        // From OpenAI help page: https://help.openai.com/en/articles/4936856-what-are-tokens-and-how-to-count-them
        // 100 tokens ~= 75 words
        return (nbWords * 100) / 75;
    }

    /**
     * Shortens the chat history by putting a 200 words summary of it at the beginning.
     */
    private async shortenChatHistory() {
        if (this.shortener === undefined) {
            throw new Error(
                "The chat history is too big. You did not register a shortener function using registerChatHistoryShortenerFunction."
            );
        }

        const summary = await this.summarizeChatHistory(this.chatHistorySummaryNbWords);

        this.chatHistory = [
            {
                role: "system",
                content: this.shortener(summary),
            },
        ];
    }

    /**
     * Takes the chat history and returns a summary of it.
     */
    public summarizeChatHistory(nbWords: number): Promise<string> {
        const response = new Promise<string>((resolve, reject) => {
            this.addSystemMessage(
                `Please make a summary of the conversation you were having. Do not make the summary longer than ${Math.round(
                    nbWords
                )} words. Please include in the summary who said what.`,
                (response: string) => {
                    resolve(response);
                }
            );

            this.scheduleRun({
                triggerTypingIndicator: false,
                dispatchAnswer: false,
            }).catch(reject);
        });
        return response;
    }

    /**
     * Registers a function that will be call to shorten the chat history.
     * The function is passed a summary of the chat history and must return a "system" prompt.
     */
    public registerChatHistoryShortenerFunction(shortener: (summary: string) => string) {
        this.shortener = shortener;
    }

    public getParticipantsUuid(): string[] {
        const playerUuids = new Set<string>();

        for (const message of this.chatHistory) {
            if (message.role === "user") {
                playerUuids.add(message.player.uuid);
            }
        }

        return Array.from(playerUuids);
    }

    get prefixWithUserNames(): boolean {
        return this._prefixWithUserNames;
    }

    set prefixWithUserNames(value: boolean) {
        this._prefixWithUserNames = value;
    }

    /**
     * Executes a callback when the bot is ready to receive a message.
     */
    public executeWhenReady(callback: () => Promise<void>): void {
        this.lock = this.lock.then(async (value) => {
            await callback();
            return value;
        });
    }

    public executeWhenDone(callback: () => Promise<void>): void {
        this.lock = this.lock.then(async (value) => {
            if (this.pendingMessages.length > 0) {
                // If there are pending messages, let's wait for them to be sent before executing the callback.
                // We call the function recursively.
                this.executeWhenDone(callback);
                return value;
            }

            await callback();
            return value;
        });
    }

    /**
     * Stops the bot. All pending requests will be ignored.
     */
    public stop() {
        this.stopped = true;
    }

    /**
     * Forces the bot to call a specific function on each call.
     * Set to undefined in order to disable this.
     */
    public forceFunction(functionName: string) {
        this.forcedFunction = functionName;
    }
}
