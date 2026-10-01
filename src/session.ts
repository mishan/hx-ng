/**
 * What the client asks of a connection.
 *
 * The page talks to a server over one of two wires: the ng protocol,
 * through `Connection`, or the classic one, through `ClassicConnection`
 * (`./classic/connection`), which reaches a classic server through a
 * relay. `Session` is the part of `Connection` this client uses, so the
 * library's surface stays the library's — `Connection` satisfies it as it
 * is — and the classic side implements the same calls, answering with the
 * same shapes, and declining what it cannot do the way an ng server
 * without the capability would.
 */

import type { Connection } from '@hotline-ng/client';

export type Session = SessionOf<Connection> & {
  /** Set on a classic server's session, where the views leave out what
   *  the classic wire has no way to do rather than draw it to fail. */
  readonly classic?: true;
};

type SessionOf<C extends Connection> = Pick<
  C,
  | 'state'
  | 'session'
  | 'token'
  | 'seq'
  | 'self'
  | 'caps'
  | 'grace'
  | 'rtt'
  | 'video'
  | 'media'
  | 'news'
  | 'push'
  | 'moderator'
  | 'moderation'
  | 'banner'
  | 'avatars'
  | 'start'
  | 'logout'
  | 'drop'
  | 'on'
  | 'hasCap'
  | 'request'
  | 'ping'
  | 'chat'
  | 'msg'
  | 'msgRead'
  | 'inbox'
  | 'history'
  | 'block'
  | 'unblock'
  | 'blocks'
  | 'kick'
  | 'report'
  | 'reports'
  | 'reportClose'
  | 'redact'
  | 'revoke'
  | 'purge'
  | 'moderationLog'
  | 'uploadMedia'
  | 'fetchMedia'
  | 'fetchBanner'
  | 'uploadAvatar'
  | 'clearAvatar'
  | 'fetchAvatar'
  | 'filesList'
  | 'fileInfo'
  | 'prepareFileDownload'
  | 'fileDownloadUrl'
  | 'fetchFile'
  | 'newsTree'
  | 'newsThreads'
  | 'newsThread'
  | 'newsArticle'
  | 'newsPost'
  | 'newsDelete'
  | 'newsRefs'
  | 'newsNodeCreate'
  | 'newsNodeRename'
  | 'newsNodeDelete'
  | 'newsSearch'
  | 'newsSubscribe'
  | 'newsUnsubscribe'
  | 'newsMute'
  | 'newsSubs'
  | 'newsSeen'
  | 'uploadNewsAttachment'
  | 'fetchNewsAttachment'
  | 'pushRegister'
  | 'pushUnregister'
>;
