import { throttle } from "throttle-debounce";
import { getMovePrompt } from "./movePrompt";
import OpenAI, { type AzureClientOptions, AzureOpenAI } from "openai";
import { z } from "zod";
import { extendZodWithOpenApi } from "@anatine/zod-openapi";
import { ChatManager } from "./chatManager";
import { moveToPlayer } from "./moveToPlayer";
import type { WaScriptMetadata } from "../WaScriptMetadata";
import { logMessage } from "./admin-api-common";

extendZodWithOpenApi(z);

export class MoveInstruction {
    protected mode: "waiting" | "chatting" = "waiting";
    protected openai!: OpenAI;
    protected movementManager!: ChatManager;
    protected metadata!: WaScriptMetadata;
    protected enableMovementManager: number = 1;
    protected enableTools: number = 1;
    /**
     *
     * @param chatHistorySummaryNbWords When summarizing the chat history, let's make a summary of this many number of words.
     * @param tokensSummaryTrigger Trigger a summary when the number of tokens in the chat history is above this number.
     * @param llmModel Openai model used.
     */
    constructor(
        protected chatHistorySummaryNbWords = 200,
        protected tokensSummaryTrigger = 3200,
        protected llmModel = "gpt-4o"
    ) {}

    /**
     * Give type in parameter ONLY for realtime bots
     * Metadata are for the realtime bot so we don't want to use the same model
     * @param metadata metadata
     * @param type Model used by openai for realtime bots, not required when using chatbot.
     */
    initMovementManager(metadata: WaScriptMetadata, type: string | null = null) {
        console.log("MoveInstructions robot is starting...");

        this.metadata = metadata;

        WA.players
            .configureTracking({
                players: true,
                movement: true,
            })
            .catch((e) => {
                console.error("Error while configuring tracking.", e);
            });

        if (!("type" in metadata.bots)) {
            throw new Error("This script can only be executed by LLM bots.");
        }

        let openAiClientOptions: AzureClientOptions;

        switch (metadata.bots.type) {
            case "customllm": {
                console.log("custom llm url", metadata.bots.customllm.customLLMUrl);
                const customApiKey = metadata.bots.customllm.apiKey ? metadata.bots.customllm.apiKey : "wa";
                this.llmModel = metadata.bots.customllm.model;
                this.enableMovementManager = metadata.bots.customllm.llmEnableMoveInstructions;
                this.enableTools = metadata.bots.customllm.llmEnableTools;
                openAiClientOptions = {
                    dangerouslyAllowBrowser: true,
                    baseURL: metadata.bots.customllm.customLLMUrl,
                    apiKey: customApiKey,
                };

                this.openai = new OpenAI(openAiClientOptions);
                break;
            }
            case "openai":
                this.llmModel = metadata.bots.openai.model;
                this.enableMovementManager = metadata.bots.openai.llmEnableMoveInstructions;
                this.enableTools = metadata.bots.openai.llmEnableTools;
                openAiClientOptions = {
                    baseURL: "https://openiaworkadventure.openai.azure.com/openai",
                    deployment: this.llmModel,
                    apiVersion: "2024-10-21",
                    dangerouslyAllowBrowser: true,
                    //eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
                    apiKey: WA.room.hashParameters.azureOpenaiApiKey,
                };

                this.openai = new AzureOpenAI(openAiClientOptions);
                break;

            case "realtime":
                this.llmModel = type || "gpt-4o-mini";
                // Set to true as verification is done in azure-robot
                this.enableMovementManager = metadata.bots.realtime.llmEnableMoveInstructions;
                // Same here tools is only called for the move instructions
                this.enableTools = metadata.bots.realtime.llmEnableTools;
                openAiClientOptions = {
                    baseURL: "https://openiaworkadventure.openai.azure.com/openai",
                    deployment: this.llmModel,
                    apiVersion: "2024-10-21",
                    dangerouslyAllowBrowser: true,
                    //eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
                    apiKey: WA.room.hashParameters.azureOpenaiApiKey,
                };

                this.openai = new AzureOpenAI(openAiClientOptions);
                break;

            default:
                throw new Error("This script can only be executed by openai or customllm bot.");
        }

        if (this.enableMovementManager) {
            this.resetMovementManager();
        }

        WA.player.proximityMeeting.onJoin().subscribe(() => {
            // When we enter a proximity meeting, we start chatting
            this.mode = "chatting";
        });

        WA.player.proximityMeeting.onLeave().subscribe(() => {
            // When we leave a proximity meeting, we stop chatting
            this.mode = "waiting";
        });

        WA.players.onVariableChange("currentPlace").subscribe(() => {
            if (this.mode === "waiting") {
                this.throttledMovePrompt();
            }
        });
    }

    private resetMovementManager(): void {
        if (this.movementManager) {
            this.movementManager.stop();
        }
        this.movementManager = new ChatManager(
            this.openai,
            this.llmModel,
            this.metadata,
            this.chatHistorySummaryNbWords,
            this.tokensSummaryTrigger,
            this.enableMovementManager
        );
        this.movementManager.logHandler.subscribe(logMessage);
        this.movementManager.registerFunction(
            "performAction",
            `Performs one of the following actions:
- goTo: Move your character next to someone in the room.
- wait: Do nothing.
`,
            z.object({
                action: z.union([z.literal("goTo"), z.literal("wait")]).openapi({
                    description: "The action to perform. MUST be either 'goTo' or 'wait'.",
                }),
                name: z.string().optional().openapi({
                    description:
                        "The name of the user you want to talk to. Only use this parameter if you are using the 'goTo' action",
                }),
            }),
            async (args) => {
                switch (args.action) {
                    case "goTo": {
                        const players = WA.players.list();
                        for (const player of players) {
                            if (player.name === args.name) {
                                await moveToPlayer(player.playerId);
                                return "Done.";
                            }
                        }
                        return `Error: Could not find a user named "${args.name}".`;
                    }
                    case "wait": {
                        // Do nothing
                        return "";
                    }
                }
            },
            false
        );
        this.movementManager.forceFunction("performAction");
    }

    private throttledMovePrompt() {
        throttle(
            30000,
            async () => {
                if (this.mode === "waiting") {
                    this.resetMovementManager();
                    const movePrompt = await getMovePrompt();

                    this.movementManager.addSystemMessage(movePrompt);
                }
            },
            {
                noTrailing: false,
                noLeading: false,
            }
        )();
    }

    protected handleError(e: unknown) {
        console.error(e);
        WA.chat.sendChatMessage("Beep bop... Sorry, I'm currently facing issues.", {
            scope: "bubble",
        });
    }
}

export const movementManager = new MoveInstruction();
