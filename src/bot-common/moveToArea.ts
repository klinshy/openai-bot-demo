import { shuffleArray } from "./moveAway";

// TODO: REMOVE ALL THIS when types are published
/* eslint-disable */

async function findArea(areaName: string): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
}> {
    // Areas can come from the TMJ file or from the map editor.
    // This function should return the area's coordinates and dimensions whatever the source.

    //TODO: REMOVE THIS when types are published
    //@ts-ignore
    const areas = await WA.mapEditor.area.list();
    //@ts-ignore
    const area = areas.find((area) => area.name.toLowerCase() === areaName.toLowerCase());
    if (area) {
        return area;
    }

    return await WA.room.area.get(areaName);
}

/**
 * Moves the user to any valid place inside the given area.
 */
export async function moveToArea(areaName: string): Promise<void> {
    const area = await findArea(areaName);

    // Let's cut this area in 32x32 squares of (x,y) coordinates and put those in an array
    const squares = [];
    for (let y = Math.round(area.y / 32); y < Math.round((area.y + area.height) / 32); y += 1) {
        for (let x = Math.round(area.x / 32); x < Math.round((area.x + area.width) / 32); x += 1) {
            squares.push({ x: x, y: y });
        }
    }

    // Shuffle the squares
    shuffleArray(squares);

    // Try to move to each square until we find a valid one
    for (const square of squares) {
        let x = square.x * 32 + 16;
        let y = square.y * 32 + 16;
        if (x < area.x) {
            x = area.x;
        }
        if (x > area.x + area.width) {
            x = area.x + area.width;
        }
        if (y < area.y) {
            y = area.y;
        }
        if (y > area.y + area.height) {
            y = area.y + area.height;
        }
        try {
            await WA.player.moveTo(x, y);
            return;
        } catch {
            // Failed to reach destination, let's try next position.
        }
    }
}
