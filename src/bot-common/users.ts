import type { WaScriptMetadata } from "../WaScriptMetadata.js";
import { updateMyPlace } from "./places.js";
import z from "zod";

/**
 * This module is executed by all users that are in a room that can have bots.
 *
 * It will update the "tags" player variable to expose the tags of the player to others.
 * It will also update the "currentPlace" player variable to expose the current place of the player to others.
 */
export default {
    async run(metadata: WaScriptMetadata) {
        await WA.onInit();
        await WA.players.configureTracking({
            players: true,
            movement: false,
        });

        await updateMyPlace();

        // Let's initialize the "tags" variable to expose our tags to others
        await WA.player.state.saveVariable("tags", WA.player.tags, {
            persist: false,
            public: true,
        });

        // Users can summon bots from their contextual menu.
        // When they do that, they will send a "summon" event to the bot.
        WA.ui.onRemotePlayerClicked.subscribe((remotePlayer) => {
            const tags = remotePlayer.state.tags;
            const TagsList = z.array(z.string());

            const safeTags = TagsList.safeParse(tags);
            if (!safeTags.success) {
                return;
            }

            const parsedTags = safeTags.data;

            if (parsedTags.includes("bot")) {
                remotePlayer.addAction("Summon", () => {
                    (async () => {
                        const position = await WA.player.getPosition();
                        //eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
                        await remotePlayer.sendEvent("summon", {
                            x: position.x,
                            y: position.y,
                        });
                    })().catch((e) => {
                        console.error(e);
                    });
                });
            }
        });

        // If the user is a map editor or an admin, let's display the bots configuration popup
        if (metadata.bots.canEdit) {
            WA.ui.registerMenuCommand("Bots (beta)", {
                iframe: new URL("/bots?token=" + WA.player.userRoomToken, metadata.bots.baseUrl).toString(),
                key: "BOTS_MENU_ITEM",
                //TODO: REMOVE THIS when types are published
                //eslint-disable-next-line @typescript-eslint/ban-ts-comment
                //@ts-ignore
                allow: "clipboard-write; clipboard-read",
            });
        }

        WA.event.on("open_website").subscribe((event) => {
            // Let's check the peron sending the event is a bot
            if (!event.senderId) {
                throw new Error("open_website is not a globally sent event");
            }
            const sender = WA.players.get(event.senderId);
            if (!sender) {
                throw new Error("Sender of open_website event not found");
            }
            if (!z.string().array().parse(sender.state.tags).includes("bot")) {
                throw new Error("Sender of open_website event is not a bot");
            }

            // Let's open the website
            const OpenWebsite = z.object({
                url: z.string(),
                new_tab: z.boolean().optional(),
                allow_api: z.boolean().optional(),
                policy: z.string().optional(),
                width: z.number().optional(),
            });
            const action = OpenWebsite.parse(event.data);
            if (action.new_tab) {
                WA.nav.openTab(action.url);
            } else {
                WA.nav.openCoWebSite(action.url, action.allow_api, action.policy, action.width).catch((e) => {
                    console.error(e);
                });
            }
        });
    },
};
