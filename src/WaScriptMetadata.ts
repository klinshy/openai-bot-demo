import z from "zod";

const OpenAiBotMetadata = z.object({
    type: z.literal("openai"),
    openai: z.object({
        model: z.string(),
        voice: z.union([
            z.literal("echo"),
            z.literal("alloy"),
            z.literal("fable"),
            z.literal("onyx"),
            z.literal("nova"),
            z.literal("shimmer"),
        ]),
        llmEnableTools: z.number(),
        llmEnableMoveInstructions: z.number(),
        llmMoveInstructions: z.string(),
        llmChatInstructions: z.string(),
    }),
});

export const OpenAiRealtimeBotMetadata = z.object({
    type: z.literal("realtime"),
    realtime: z.object({
        model: z.string(),
        voice: z.union([
            z.literal("echo"),
            z.literal("alloy"),
            z.literal("shimmer"),
            z.literal("ash"),
            z.literal("ballad"),
            z.literal("coral"),
            z.literal("sage"),
            z.literal("verse"),
        ]),
        llmEnableTools: z.number(),
        llmEnableMoveInstructions: z.number(),
        llmMoveInstructions: z.string(),
        llmChatInstructions: z.string(),
        sessionTimeout: z.number(),
    }),
});
export type OpenAiRealtimeBotMetadata = z.infer<typeof OpenAiRealtimeBotMetadata>;

const TockBotMetadata = z.object({
    type: z.literal("tock"),
    tock: z.object({
        restApiUrl: z.string(),
        movementMode: z.union([z.literal("welcome"), z.literal("still")]),
    }),
});

const CustomBotMetadata = z.object({
    type: z.literal("custom"),
    custom: z.object({
        customScriptUrl: z.string(),
    }),
});

const CustomLLMBotMetadata = z.object({
    type: z.literal("customllm"),
    customllm: z.object({
        model: z.string(),
        customLLMUrl: z.string(),
        apiKey: z.string(),
        llmEnableTools: z.number(),
        llmEnableMoveInstructions: z.number(),
        llmMoveInstructions: z.string(),
        llmChatInstructions: z.string(),
    }),
});

export const BotMetadata = z.union([
    OpenAiBotMetadata,
    OpenAiRealtimeBotMetadata,
    TockBotMetadata,
    CustomBotMetadata,
    CustomLLMBotMetadata,
    z.object({}),
]);

export const WaScriptMetadata = z.object({
    adminUrl: z.string(),
    quests: z
        .object({
            baseUrl: z.string(),
            keys: z.string().array(),
        })
        .optional(),
    msteams: z.boolean().optional(),
    room: z
        .object({
            isTestEnv: z.boolean(),
            isPremium: z.boolean(),
            brandingActivated: z.boolean(),
            isTrial: z.boolean(),
        })
        .optional(),
    headbands: z
        .array(
            z.object({
                body: z.string(),
                link: z
                    .object({
                        url: z.string(),
                        label: z.string(),
                    })
                    .nullable()
                    .optional(),
            })
        )
        .optional(),
    bots: z
        .object({
            enable: z.boolean(),
            baseUrl: z.string(),
            canEdit: z.boolean(),
            hashParams: z.string().nullable().optional(),
        })
        .and(BotMetadata.optional()),
    enableTutorial: z.boolean().optional(),
    integrations: z
        .object({
            baseUrl: z.string(),
            showElement: z.boolean(),
            showMsTeams: z.boolean(),
            showOutlook: z.boolean(),
            showGoogleCalendar: z.boolean(),
        })
        .optional(),
});
export type WaScriptMetadata = z.infer<typeof WaScriptMetadata>;
