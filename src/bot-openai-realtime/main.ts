import type { WaScriptMetadata } from "../WaScriptMetadata";
import { azureRobot } from "./azure-robot";

/**
 * This module is executed by the open-ai bot users only.
 */
export default {
    async run(metadata: WaScriptMetadata) {
        await WA.onInit();

        await WA.players.configureTracking({
            players: true,
            movement: true,
        });
        await azureRobot.init(metadata);
    },
};
