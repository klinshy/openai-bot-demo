import { generatePlacesPrompt } from "./places";
import { generatePeopleByPlacesPrompt, generatePeopleByRolePrompt, generatePeopleTalkHistory } from "./people";
import { WaScriptMetadata } from "../WaScriptMetadata";

export async function getMovePrompt(): Promise<string> {
    const now = new Date();
    const metadata = WaScriptMetadata.parse(WA.metadata);

    return `You are a bot living in a WorkAdventure map.
Today is ${now.toLocaleDateString("en-us", {
        weekday: "long",
        year: "numeric",
        month: "short",
        day: "numeric",
    })}. It is ${now.toLocaleTimeString("en-us", { hour: "2-digit", minute: "2-digit" })}.

${await generatePlacesPrompt()}
${generatePeopleByPlacesPrompt()}
${generatePeopleByRolePrompt()}
${await generatePeopleTalkHistory()}

${"type" in metadata.bots && metadata.bots.type === "openai" ? metadata.bots.openai.llmMoveInstructions : ""}
    `;
}
