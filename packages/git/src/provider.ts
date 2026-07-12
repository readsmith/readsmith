/**
 * The git-provider port. Drivers turn "this repo at this commit" into a working
 * tree on disk; how they authenticate (App installation token, PAT) and talk to
 * their host is entirely theirs. The GitHub driver lands with the webhook
 * surface; this port grows auth and event parsing additively when it does.
 */
export interface FetchTarget {
  /** `owner/name`. */
  repo: string;
  /** The exact commit to materialize (never a branch head: reproducibility). */
  commitSha: string;
}

export interface GitProvider {
  /**
   * Materialize the repository working tree at the exact commit into `destDir`
   * (an existing, empty, caller-owned scratch directory). Implementations must
   * be bounded (size/time caps) and must never write outside `destDir`.
   */
  fetchAtRef(target: FetchTarget, destDir: string): Promise<void>;
}
