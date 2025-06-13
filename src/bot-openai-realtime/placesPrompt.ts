import {findMapEditorPlaces} from "../bot-common/places";

// TODO: REMOVE ALL THIS when types are published
/* eslint-disable */
export async function generatePlacesPrompt(): Promise<string> {
    const zones = await findMapEditorPlaces();

    let prompt = "In your map, you can find the following places:\n\n";

    for (const [name, description] of zones.entries()) {
        if (name) {
            prompt += `- ${name}\n`;
        }
    }

    prompt += "\nYou can call the 'getPlaces' tool to get more information about a specific place.";

    return prompt;
}
