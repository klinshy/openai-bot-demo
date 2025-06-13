import type { Position } from "@workadventure/iframe-api-typings";
import { getLayersMap, Properties } from "@workadventure/scripting-api-extra/dist";

enum Direction {
    UP,
    DOWN,
    LEFT,
    RIGHT,
}

/**
 * This function has the difficult task of moving away from a bubble.
 * Ideally, we should move away in a free spot. Right now, the function does not look if the spot it is moving to is free or not.
 */
export async function moveAway(): Promise<void> {
    const position = await WA.player.getPosition();

    const directions = [Direction.UP, Direction.DOWN, Direction.LEFT, Direction.RIGHT];
    // Shuffle the directions
    shuffleArray(directions);

    for (const direction of directions) {
        const destination = getDestinationByDirection(position, direction);

        const properties = await getPropertiesAtPosition(destination);
        if (!isAcceptableZone(properties)) {
            continue;
        }

        try {
            await WA.player.moveTo(destination.x, destination.y);
            return;
        } catch {
            // Failed to reach destination, let's try next position.
        }
    }
    console.error("We failed to move away from the bubble.");
}

// TODO: avoid the bot moving to a silent zone
// TODO: avoid the bot moving to a meeting room
async function getPropertiesAtPosition(position: Position): Promise<Properties> {
    const tileLayers = await getLayersMap();

    const properties = [];

    for (const layer of tileLayers.values()) {
        // Let's get the properties of the objects at the position
        if (layer.type === "objectgroup") {
            for (const object of layer.objects) {
                if (
                    object.properties !== undefined &&
                    object.width !== undefined &&
                    object.height !== undefined &&
                    object.x <= position.x &&
                    object.x + object.width >= position.x &&
                    object.y <= position.y &&
                    object.y + object.height >= position.y
                ) {
                    properties.push(...object.properties);
                }
            }
        } else if (layer.type === "tilelayer") {
            const x = Math.floor(position.x / 32);
            const y = Math.floor(position.y / 32);
            const tileIndex = y * layer.width + x;
            if (tileIndex >= layer.data.length) {
                continue;
            }
            const tileId = layer.data[tileIndex];
            if (tileId !== 0) {
                if (layer.properties !== undefined) {
                    properties.push(...layer.properties);
                }

                // TODO: read tile properties too.
                /*const tileset = layer.tilesets.find(tileset => tileset.firstgid <= tileId && tileset.firstgid + tileset.tilecount >= tileId);
                if (tileset !== undefined) {
                    const tileProperties = tileset.tiles.find(tile => tile.id === tileId - tileset.firstgid)?.properties;
                    if (tileProperties !== undefined) {
                        properties.push(...tileProperties);
                    }
                }*/
            }
        }
    }

    return new Properties(properties);
}

function isAcceptableZone(properties: Properties): boolean {
    return properties.getBoolean("silent") !== true && properties.get("jitsiRoom") === undefined;
}

export function shuffleArray<T>(array: Array<T>) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
}

function getDestinationByDirection(position: Position, direction: Direction): Position {
    switch (direction) {
        case Direction.UP:
            return { x: position.x, y: position.y - 196 };
        case Direction.DOWN:
            return { x: position.x, y: position.y + 196 };
        case Direction.LEFT:
            return { x: position.x - 196, y: position.y };
        case Direction.RIGHT:
            return { x: position.x + 196, y: position.y };
    }
}
