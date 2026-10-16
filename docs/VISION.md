# Vision

## What if filmmaking worked like software development?

Coding agents are changing how software is built. A developer describes what they want, lets an agent implement it, reviews the result, and guides the next iteration.

This works because coding agents were built around the structure of software development. They navigate projects, execute commands, manage dependencies, and iterate on artifacts that can be inspected and changed.

konte brings that way of working to filmmaking.

## One clip is easy. A film is a project.

AI has made generating a single video clip remarkably accessible. A coding agent can call a generation API, save the result, and produce something impressive.

But a film is more than a collection of clips.

Even a short film involves dozens of shots, hundreds of generated takes, shared character references, dependencies between assets, and repeated creative revisions. Someone has to keep track of what has been generated, which takes were selected, what depends on what, and what has to change when the director gives feedback.

These are not generation problems. They are production management problems, and they look a lot like the problems software engineering has spent decades learning to solve.

## Structure the work the way agents already work

Most AI filmmaking tools are applications built for a human to operate. To automate one, you build an agent that learns to drive that interface.

konte takes the opposite approach.

**Instead of teaching an agent to operate a filmmaking tool, we structure filmmaking as a software project that coding agents already know how to work with.**

A konte project makes the production explicit: the creative direction, the shots, the assets and the dependencies between them, every generated take, which takes were selected, and the feedback on each. The agent navigates that structure, runs production tools, inspects results, and makes changes using the same general capabilities it uses for software.

The media may come from ComfyUI or another backend, but the agent works with the production through one consistent project interface.

We don't rebuild the reasoning, tool execution, or project navigation that coding agents already provide. We build on them. And if you are comfortable directing a coding agent to build software, you already know how to direct one to make a film.

## You direct. Your agent produces.

The more interesting change isn't how production tasks get executed. It's how the human's role changes.

In agent-assisted software development, developers are moving from implementing every detail toward specifying intent, reviewing results, and making decisions. Filmmaking can follow the same path.

The human defines the creative vision, watches the cut, judges what works, and decides what has to change. The agent does the production work: developing the shot plan, generating assets, managing takes, tracking dependencies, and carrying feedback into the next iteration.

Say the lighting in the second shot feels flat. The agent rerolls that shot, leaves everything you have already accepted in place, and the cut updates. You watch it again and decide.

Creative judgment doesn't disappear here. Quite the opposite. A film cannot be evaluated by automated tests. Whether a moment feels right, a performance is convincing, or a sequence communicates the intended emotion is a judgment only the director can make.

**The goal is not to remove the director. It's to let the director spend more time directing.**

## Built to improve as agents improve

Today's coding agents can already coordinate meaningful production work, and they are still getting better: at planning complex work, holding context across long projects, understanding creative feedback, and revising their own output.

konte is designed to benefit from that progress. Because it relies on general-purpose coding agents rather than a fixed, specialized filmmaking intelligence, every improvement in those agents expands what a konte production can accomplish. A more capable agent can manage more shots, coordinate more complicated dependencies, keep consistency across longer sequences, and respond to more sophisticated direction.

With an ad hoc workflow, more clips mean more files, decisions, dependencies, and revisions to keep in your head. A smarter agent helps, but the complexity doesn't go away. A structured project gives that growing intelligence a stable foundation: production state is explicit, decisions are preserved, and the agent always operates in the same environment.

This is the bet behind konte:

**As coding agents get smarter, their growing intelligence should translate directly into what filmmakers can create, in both quality and scale.**

The better agents get, the more you can create.

## Beyond video

Much of today's software is designed for a human to operate step by step. The common path to automation is an agent that learns to operate those interfaces.

There is another path: redesign the work itself into the form agents are already exceptionally good at handling. For a coding agent, that form is a software project, with structured files, explicit state, executable tools, dependencies, and iterative changes.

The hard part is finding the domain's real structure and making it explicit. For filmmaking, that means more than putting a timeline in code. It means representing the production process itself: assets, decisions, alternatives, dependencies, and feedback.

konte is one exploration of that idea. We believe it applies to other complex creative work as well.

## The future we're building toward

Imagine producing a film the way you increasingly build software with a coding agent.

You describe the film you want to make. Your agent helps develop the idea, plans the production, coordinates the generation tools, and assembles a cut. You watch it. You explain what you want to change, and the agent carries the production forward, preserving what already works.

As agents improve, the same workflow handles longer, more complex, and more ambitious projects.

konte is an early step toward that future: a working attempt to give coding agents the structure and tools they need to work on a film as production collaborators.

**Coding agents are changing how we build software. We believe they can change how we make films, too.**

---

**konte: You direct. Your agent produces.**
