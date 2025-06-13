import { moveToArea } from "./moveToArea";
import type { RemotePlayerInterface } from "@workadventure/iframe-api-typings";

/**
 * Leads all users to a specific area.
 *
 * It will properly wait for all users to be in the area before returning.
 */
export async function leadTo(areaName: string): Promise<void> {
    await WA.players.configureTracking({
        players: true,
        movement: true,
    });

    // A map of followers and whether they are in range or not
    const followers: Map<RemotePlayerInterface, boolean> = new Map();

    const onPlayerMovesSubscription = WA.players.onPlayerMoves.subscribe((event) => {
        (async () => {
            const follower = followers.get(event.player);
            if (!follower) {
                return;
            }

            const myPosition = await WA.player.getPosition();
            const distance = Math.sqrt(
                Math.pow(myPosition.x - event.newPosition.x, 2) + Math.pow(myPosition.y - event.newPosition.y, 2)
            );

            console.log("Distance to " + event.player.name + ": " + distance + " pixels");
            followers.set(event.player, distance < 64);
        })().catch((e) => console.error(e));
    });

    // TODO: Remove this when the follow API is tagged.
    /* eslint @typescript-eslint/no-unsafe-member-access: "off" */
    /* eslint @typescript-eslint/no-unsafe-call: "off" */
    /* eslint @typescript-eslint/no-unsafe-argument: "off" */
    /* eslint @typescript-eslint/no-unsafe-assignment: "off" */

    // TODO: Remove this when the follow API is tagged.
    //eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-ignore
    const onFollowedSubscription = WA.player.proximityMeeting.onFollowed().subscribe((player) => {
        console.log(player.name + " is following me");
        for (const remotePlayer of WA.players.list()) {
            if (remotePlayer.playerId === player.playerId) {
                followers.set(remotePlayer, true);
            }
        }
    });
    // Remove this when the follow API is tagged.
    //eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-ignore
    const onUnfollowedSubscription = WA.player.proximityMeeting.onUnfollowed().subscribe((player) => {
        console.log(player.name + " is not following me anymore");
        followers.delete(player);
    });

    // Remove this when the follow API is tagged.
    //eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-ignore
    await WA.player.proximityMeeting.followMe();
    await moveToArea(areaName);

    for (let i = 0; i < 10; i++) {
        let allInArea = true;
        for (const follower of followers.values()) {
            if (!follower) {
                console.log("Not everybody is in range yet");
                allInArea = false;
                break;
            }
        }
        if (allInArea) {
            console.log("Everybody is in range. Let's stop leading the group.");
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Remove this when the follow API is tagged.
    //eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-ignore
    await WA.player.proximityMeeting.stopLeading();

    onPlayerMovesSubscription.unsubscribe();
    onFollowedSubscription.unsubscribe();
    onUnfollowedSubscription.unsubscribe();
}
