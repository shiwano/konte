import { defineReference } from "konte";
import direction from "./direction";

// Shared building blocks (characters, props, locations, BGM) generated once and reused across
// stages; reach them elsewhere as `reference.<name>`. Read the `authoring-guide` skill.
export default defineReference(direction, () => {
  return {};
});
