/**
 * Titles of the throwaway sessions the plugins open to call a model.
 *
 * opencode's API has no headless prompt: asking a model anything requires a
 * real session, so summarising a task and proposing a session title both open
 * one, read the reply, and delete it.
 *
 * Those sessions are indistinguishable from the user's own unless something
 * names them, and that matters twice over:
 *
 *   - The task runner wraps every new session into a task so it occupies a
 *     concurrency slot. Wrapping a scratch session queues a task, whose own
 *     summary opens another scratch session, and so on — an unbounded loop that
 *     once filled the queue with 177 entries.
 *   - session-rename renames every session that goes idle. Renaming a scratch
 *     session starts a rename, which opens another scratch session.
 *
 * Each producer owns its own title, but every consumer needs to recognise *all*
 * of them, so the set lives here rather than in any one module. A plugin that
 * adds a scratch session registers its title here and is skipped everywhere
 * automatically, instead of leaking into whichever consumer was not updated.
 */

/**
 * Every known scratch-session title.
 *
 * Seeded with the titles the shipped plugins use rather than relying purely on
 * `register`, because registration only happens once the producing module is
 * loaded. A consumer that runs before its producer — a reconcile pass before
 * session-rename has been touched, or a maintenance script importing only the
 * task store — would otherwise fail to recognise a scratch session and adopt
 * it, which is the loop this module exists to prevent.
 */
const TITLES = new Set<string>(["task-queue summary", "session-rename: proposing a title"])

/** Claim a title as scratch. Called once, at module load, by each producer. */
export function register(title: string): string {
  TITLES.add(title)
  return title
}

/** Whether a session title marks it as a plugin's own scratch workspace. */
export function isScratchTitle(title: string | null | undefined): boolean {
  return typeof title === "string" && TITLES.has(title)
}

/** The registered titles, for diagnostics. */
export function titles(): string[] {
  return [...TITLES]
}
