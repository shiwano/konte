import { defineAnimatic } from "konte";
import direction from "./direction";

// The board on the direction's clock — walk it with the injected `shot(id, build)` /
// `.nextShot(id, build)`, each build returning a `<Composition>` whose keyframes are `<Panel>` and
// whose spoken lines are `<Audio>`. Read the `staging-guide` skill before writing a panel's prompt,
// and `authoring-guide` for how to declare and wire assets here.
export default defineAnimatic(direction, {
  timeline: () => ({ shots: [] }),
});
