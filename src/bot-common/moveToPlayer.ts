/**
 * Moves to the player with the given ID.
 * If the player moves, the bot will follow them until it reaches the player.
 * @param playerId
 */
export async function moveToPlayer(playerId: number): Promise<{ x: number; y: number; cancelled: boolean }> {
    const player = WA.players.get(playerId);
    if (!player) {
        throw new Error(`Player with ID ${playerId} not found.`);
    }

    let movementPromise = WA.player.moveTo(player.position.x, player.position.y);
    const listener = player.position$.subscribe(() => {
        movementPromise = WA.player.moveTo(player.position.x, player.position.y);
        movementPromise
            .then((result) => {
                if (!result.cancelled) {
                    listener.unsubscribe();
                }
            })
            .catch((e) => {
                console.error("Error moving to player: ", e);
            });
    });
    movementPromise
        .then((result) => {
            if (!result.cancelled) {
                listener.unsubscribe();
            }
        })
        .catch((e) => {
            console.error("Error moving to player: ", e);
        });
    return movementPromise;
}
