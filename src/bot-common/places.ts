import { getLayersMap, Properties } from "@workadventure/scripting-api-extra/dist";

// TODO: REMOVE ALL THIS when types are published
/* eslint-disable */

let placesPromise: Promise<Map<string, string | undefined>> | undefined;

/**
 * Returns a list of areas with descriptions defined in the map editor.
 */
export async function findMapEditorPlaces(filter?: string | undefined): Promise<Map<string, string | undefined>> {
    if (placesPromise !== undefined) {
        return placesPromise;
    }

    return new Promise((resolve, reject) => {
        (async () => {
            //@ts-ignore
            const areas = await WA.mapEditor.area.list();
            //@ts-ignore
            const places = areas
                //@ts-ignore
                .map((area) => {
                    return [area.name, area.description];
                })
                //@ts-ignore
                .filter(([name, description]) => {
                    if (!filter) {
                        return true;
                    }
                    return name !== undefined && name.includes(filter);
                });

            resolve(new Map(places as [string, string | undefined][]));
        })().catch((e) => {
            reject(e);
        });
    });
}

export async function findPlaces(): Promise<Map<string, string | undefined>> {
    if (placesPromise !== undefined) {
        return placesPromise;
    }

    return new Promise((resolve, reject) => {
        (async () => {
            const zones = new Map<string, string | undefined>();

            const layers = await getLayersMap();
            for (const layer of layers.values()) {
                if (layer.type === "objectgroup") {
                    for (const object of layer.objects) {
                        if (object.type === "area" || object.class === "area") {
                            const properties = new Properties(object.properties);
                            if (properties.getBoolean("ai-zone") === true) {
                                zones.set(object.name, properties.getString("description"));
                            }
                        }
                    }
                }
            }

            resolve(zones);
        })().catch((e) => {
            reject(e);
        });
    });
}

export async function generatePlacesPrompt(): Promise<string> {
    const zones = await findPlaces();

    let prompt = "In your map, you can find the following places:\n\n";

    for (const [name, description] of zones.entries()) {
        prompt += `- ${name}: ${description}\n`;
    }

    return prompt;
}

export async function updateMyPlace(): Promise<void> {
    const places = await findPlaces();
    // listen to player entering room area
    for (const areaName of places.keys()) {
        WA.room.area.onEnter(areaName).subscribe(() => {
            WA.player.state
                .saveVariable("currentPlace", areaName, {
                    persist: false,
                    public: true,
                })
                .catch((e) => console.error(e));
        });
    }
    const mapEditorPlaces = await findMapEditorPlaces();
    // listen to player entering mapEditor area
    for (const areaName of mapEditorPlaces.keys()) {
        //@ts-ignore
        WA.mapEditor.area.onEnter(areaName).subscribe(() => {
            WA.player.state
                .saveVariable("currentPlace", areaName, {
                    persist: false,
                    public: true,
                })
                .catch((e) => console.error(e));
        });
    }
}
