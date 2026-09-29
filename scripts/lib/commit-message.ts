export type CommitMessageOptions = {
  /** `package.json`'s version at the commit — the one a release subject has to name. */
  version?: string;
};

const SUBJECT_MAX = 72;
const BODY_MAX = 80;

const RELEASE_MARK = "🎬";
const RELEASE = /^🎬 Cut v(\S+)$/u;
// Written by git, and gone once the branch is squashed.
const GIT_AUTHORED = /^(?:fixup|squash|amend)! |^Merge /;
const REVERT = /^Revert "/;
// What GitHub appends to a squash-merged subject.
const PR_SUFFIX = / \(#\d+\)$/;
const TYPE_PREFIX = /^[A-Za-z]+(?:\([^)]*\))?!?: /;
const EMOJI = /\p{Extended_Pictographic}/u;
const ATTRIBUTION = /^(?:co-authored-by:|generated[- ](?:by|with)\b)/i;
const MARKDOWN_BLOCK = /^\s*(?:[-*+] |\d+[.)] |#{1,6} |```)/;
const SCISSORS = /^# -+ >8 -+$/;

/** A `commit-msg` file as git hands it to the hook, minus what git itself drops. */
export function stripGitComments(message: string): string {
  const lines = message.split("\n");
  const scissors = lines.findIndex((line) => SCISSORS.test(line));
  return (scissors === -1 ? lines : lines.slice(0, scissors))
    .filter((line) => !line.startsWith("#"))
    .join("\n");
}

export function checkCommitMessage(message: string, options: CommitMessageOptions = {}): string[] {
  const lines = message
    .replace(/\r\n?/g, "\n")
    .trim()
    .split("\n")
    .map((line) => line.trimEnd());
  const subject = (lines[0] ?? "").replace(PR_SUFFIX, "");
  const body = lines.slice(1);

  if (subject === "") return ["the subject is empty"];
  if (GIT_AUTHORED.test(subject)) return [];
  if (subject.startsWith(RELEASE_MARK)) return checkRelease(subject, body, options);

  const errors: string[] = [];
  const length = [...subject].length;
  if (length > SUBJECT_MAX && !REVERT.test(subject)) {
    errors.push(`the subject is ${length} characters — at most ${SUBJECT_MAX}`);
  }
  if (TYPE_PREFIX.test(subject)) {
    errors.push(`the subject has a type prefix — drop "${TYPE_PREFIX.exec(subject)![0]}"`);
  } else if (!/^[A-Z]/.test(subject)) {
    errors.push("the subject starts lowercase — capitalize its first word");
  }
  if (subject.endsWith(".")) errors.push("the subject ends with a period");
  if (EMOJI.test(subject)) errors.push(`the subject has an emoji — only a release commit has one`);

  if (body.length > 0 && body[0] !== "") {
    errors.push("line 2 is not blank — separate the subject from the body");
  }
  body.forEach((line, index) => {
    const at = `line ${index + 2}`;
    const width = [...line].length;
    if (width > BODY_MAX && /\s/.test(line.trim()) && !line.includes("://")) {
      errors.push(`${at} is ${width} characters — wrap the body at ${BODY_MAX}`);
    }
    if (ATTRIBUTION.test(line)) errors.push(`${at} is an attribution trailer — remove it`);
    if (MARKDOWN_BLOCK.test(line)) errors.push(`${at} is Markdown structure — the body is prose`);
    if (EMOJI.test(line)) errors.push(`${at} has an emoji`);
  });
  return errors;
}

function checkRelease(subject: string, body: string[], options: CommitMessageOptions): string[] {
  const errors: string[] = [];
  const version = RELEASE.exec(subject)?.[1];
  if (version === undefined) {
    errors.push(`a release subject is "${RELEASE_MARK} Cut v<version>"`);
  } else if (options.version !== undefined && version !== options.version) {
    errors.push(`the subject names v${version}, package.json is at v${options.version}`);
  }
  if (body.some((line) => line !== "")) errors.push("a release commit has no body");
  return errors;
}
