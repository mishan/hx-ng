//! hxsession for JavaScript.
//!
//! [`ClassicSession`] is a `hxsession::Session` with a JavaScript face:
//! bytes in from a WebSocket, bytes out to it, events out as plain
//! objects whose shapes `src/classic/wire.ts` spells out in TypeScript.
//! It holds no socket and no timer; `src/classic/connection.ts` owns both.
//!
//! Times are milliseconds as JavaScript numbers. They only need to be
//! monotonic, and `performance.now()` is.

use hxsession::{Closed, Config, Error, Event, Session};
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// A session's events, as JavaScript sees them: `{ type: "chat", ... }`.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum JsEvent {
    LoggedIn {
        version: u16,
        name: Option<String>,
        uid: Option<u16>,
    },
    Agreement {
        text: String,
    },
    Ready,
    Chat {
        cid: u32,
        uid: u16,
        text: String,
    },
    Message {
        uid: u16,
        from: String,
        text: String,
    },
    Broadcast {
        uid: u16,
        from: String,
        text: String,
    },
    Disconnecting {
        text: String,
    },
    UserList {
        users: Vec<JsUser>,
    },
    UserChanged {
        cid: u32,
        user: JsUser,
    },
    UserLeft {
        cid: u32,
        uid: u16,
    },
    SelfInfo {
        uid: u16,
        icon: u16,
    },
    UserInfo {
        trans: u32,
        name: String,
        info: String,
    },
    FileList {
        trans: u32,
        files: Vec<JsFile>,
    },
    NewsFile {
        trans: u32,
        text: String,
    },
    NewsPosted {
        text: String,
    },
    NewsListing {
        trans: u32,
        items: Vec<JsNewsItem>,
    },
    NewsCategory {
        trans: u32,
        articles: Vec<JsArticle>,
    },
    NewsArticle {
        trans: u32,
        text: String,
    },
    Failed {
        trans: u32,
        reason: Option<String>,
    },
    Unhandled {
        opcode: u32,
    },
    Closed {
        reason: String,
        /// The server refused the login, as opposed to the connection
        /// failing: a reason to ask for other credentials, not to retry.
        refused: bool,
    },
}

#[derive(Serialize)]
struct JsUser {
    uid: u16,
    icon: u16,
    status: Option<u16>,
    name: String,
    color: Option<u32>,
}

#[derive(Serialize)]
struct JsFile {
    name: String,
    /// The name's bytes, to name the entry back to the server with.
    #[serde(with = "serde_bytes_array")]
    name_bytes: Vec<u8>,
    folder: bool,
    /// A JavaScript number: exact to 2^53 bytes.
    size: f64,
    type_code: [u8; 4],
    creator: [u8; 4],
}

#[derive(Serialize)]
struct JsNewsItem {
    name: String,
    #[serde(with = "serde_bytes_array")]
    name_bytes: Vec<u8>,
    bundle: bool,
}

/// Bytes as a `Uint8Array` rather than an array of numbers.
mod serde_bytes_array {
    use serde::Serializer;
    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bytes(v)
    }
}

#[derive(Serialize)]
struct JsArticle {
    id: u32,
    parent: u32,
    subject: String,
    poster: String,
    year: u16,
    seconds: u32,
}

fn user(u: hxsession::User) -> JsUser {
    JsUser {
        uid: u.uid,
        icon: u.icon,
        status: u.status,
        name: u.name,
        color: u.color,
    }
}

fn closed(c: Closed) -> (String, bool) {
    match c {
        Closed::BadMagic(m) if &m[..4] == b"TRTP" => (
            format!(
                "The server turned the connection away (error {}).",
                u32::from_be_bytes([m[4], m[5], m[6], m[7]])
            ),
            false,
        ),
        Closed::BadMagic(_) => ("That is not a Hotline server.".into(), false),
        Closed::LoginRefused(r) => (
            r.unwrap_or_else(|| "The server refused the login.".into()),
            true,
        ),
        Closed::Timeout => ("The server did not answer the login.".into(), false),
        Closed::Protocol(why) => (
            format!("The connection stopped making sense: {why}."),
            false,
        ),
        Closed::TooLarge(n) => (
            format!("The server sent more at once than this client takes ({n} bytes)."),
            false,
        ),
        Closed::Hangup => ("The connection closed.".into(), false),
        // `Closed` may grow; a reason is better than none.
        #[allow(unreachable_patterns)]
        other => (format!("{other:?}"), false),
    }
}

fn js_event(e: Event) -> JsEvent {
    match e {
        Event::LoggedIn(i) => JsEvent::LoggedIn {
            version: i.version,
            name: i.name,
            uid: i.uid,
        },
        Event::Agreement(text) => JsEvent::Agreement { text },
        Event::Ready => JsEvent::Ready,
        Event::Chat { cid, uid, text, .. } => JsEvent::Chat { cid, uid, text },
        Event::Message {
            uid, from, text, ..
        } => JsEvent::Message { uid, from, text },
        Event::Broadcast { uid, from, text } => JsEvent::Broadcast { uid, from, text },
        Event::Disconnecting(text) => JsEvent::Disconnecting { text },
        Event::UserList { users, .. } => JsEvent::UserList {
            users: users.into_iter().map(user).collect(),
        },
        Event::UserChanged { cid, user: u } => JsEvent::UserChanged { cid, user: user(u) },
        Event::UserLeft { cid, uid } => JsEvent::UserLeft { cid, uid },
        // Janus and hlservd leave our uid out; there is nothing to say then.
        Event::SelfInfo {
            uid: Some(uid),
            icon: Some(icon),
            ..
        } => JsEvent::SelfInfo { uid, icon },
        Event::UserInfo { trans, name, info } => JsEvent::UserInfo { trans, name, info },
        Event::FileList { trans, files } => JsEvent::FileList {
            trans,
            files: files
                .into_iter()
                .map(|f| JsFile {
                    name: f.name,
                    name_bytes: f.name_bytes,
                    folder: f.folder,
                    size: f.size as f64,
                    type_code: f.type_code,
                    creator: f.creator,
                })
                .collect(),
        },
        Event::NewsFile { trans, text } => JsEvent::NewsFile { trans, text },
        Event::NewsPosted(text) => JsEvent::NewsPosted { text },
        Event::NewsListing { trans, items } => JsEvent::NewsListing {
            trans,
            items: items
                .into_iter()
                .map(|i| JsNewsItem {
                    name: i.name,
                    name_bytes: i.name_bytes,
                    bundle: i.bundle,
                })
                .collect(),
        },
        Event::NewsCategory { trans, articles } => JsEvent::NewsCategory {
            trans,
            articles: articles
                .into_iter()
                .map(|a| JsArticle {
                    id: a.id,
                    parent: a.parent,
                    subject: a.subject,
                    poster: a.poster,
                    year: a.year,
                    seconds: a.seconds,
                })
                .collect(),
        },
        Event::NewsArticle { trans, text } => JsEvent::NewsArticle { trans, text },
        Event::Failed { trans, reason } => JsEvent::Failed { trans, reason },
        Event::Reply { trans, .. } => JsEvent::Failed {
            trans,
            reason: Some("Nothing here reads that reply.".into()),
        },
        Event::Unhandled { opcode, .. } => JsEvent::Unhandled { opcode },
        Event::Closed(c) => {
            let (reason, refused) = closed(c);
            JsEvent::Closed { reason, refused }
        }
        // `Event` may grow; anything newer is unhandled here until it is
        // given a shape.
        #[allow(unreachable_patterns)]
        _ => JsEvent::Unhandled { opcode: 0 },
    }
}

/// The name a refusal's `Error` carries. A refusal is an answer — too
/// long, not logged in — and a trap is the module failing; the caller
/// ends the session for the second and only reports the first.
const REFUSAL: &str = "ClassicRefusal";

fn js_error(e: Error) -> JsValue {
    let err = js_sys::Error::new(match e {
        Error::NotReady => "Not logged in.",
        Error::TooLong => "That is too long to send.",
        Error::NoAgreement => "There is no agreement to answer.",
        #[allow(unreachable_patterns)]
        _ => "Refused.",
    });
    err.set_name(REFUSAL);
    err.into()
}

fn ms(t: f64) -> u64 {
    if t.is_finite() && t > 0.0 {
        t as u64
    } else {
        0
    }
}

/// A path given as an array of `Uint8Array`s: each component's bytes.
fn raw_path(p: &js_sys::Array) -> Vec<Vec<u8>> {
    p.iter()
        .map(|v| js_sys::Uint8Array::new(&v).to_vec())
        .collect()
}

fn slices(p: &[Vec<u8>]) -> Vec<&[u8]> {
    p.iter().map(Vec::as_slice).collect()
}

/// What a login needs, from JavaScript.
#[wasm_bindgen]
pub struct ClassicConfig {
    login: String,
    password: String,
    nick: String,
    icon: u16,
}

#[wasm_bindgen]
impl ClassicConfig {
    #[wasm_bindgen(constructor)]
    pub fn new(login: String, password: String, nick: String, icon: u16) -> ClassicConfig {
        ClassicConfig {
            login,
            password,
            nick,
            icon,
        }
    }
}

#[wasm_bindgen]
pub struct ClassicSession {
    s: Session,
}

#[wasm_bindgen]
impl ClassicSession {
    /// A session with its handshake queued: send `takeOutgoing()` once the
    /// socket is open.
    #[wasm_bindgen(constructor)]
    pub fn new(cfg: ClassicConfig, now: f64) -> ClassicSession {
        let mut c = if cfg.login.is_empty() {
            Config::guest(&cfg.nick)
        } else {
            Config::account(&cfg.nick, &cfg.login, &cfg.password)
        };
        c.icon = cfg.icon;
        ClassicSession {
            s: Session::new(c, ms(now)),
        }
    }

    pub fn feed(&mut self, bytes: &[u8], now: f64) {
        self.s.feed(bytes, ms(now));
    }

    pub fn tick(&mut self, now: f64) {
        self.s.tick(ms(now));
    }

    /// Bytes to write to the socket; empty when there are none.
    #[wasm_bindgen(js_name = takeOutgoing)]
    pub fn take_outgoing(&mut self) -> Vec<u8> {
        self.s.take_outgoing()
    }

    /// The next event, or `undefined`.
    #[wasm_bindgen(js_name = pollEvent)]
    pub fn poll_event(&mut self) -> Result<JsValue, JsValue> {
        match self.s.poll_event() {
            None => Ok(JsValue::UNDEFINED),
            Some(e) => serde_wasm_bindgen::to_value(&js_event(e))
                .map_err(|e| JsValue::from(js_sys::Error::new(&e.to_string()))),
        }
    }

    /// When `tick` next has work, or `undefined` for never.
    #[wasm_bindgen(js_name = nextDeadline)]
    pub fn next_deadline(&self) -> Option<f64> {
        self.s.next_deadline().map(|t| t as f64)
    }

    pub fn disconnected(&mut self) {
        self.s.disconnected();
    }

    pub fn agree(&mut self) -> Result<(), JsValue> {
        self.s.agree().map_err(js_error)
    }

    pub fn chat(&mut self, text: &str, emote: bool) -> Result<u32, JsValue> {
        let r = if emote {
            self.s.emote(text)
        } else {
            self.s.chat(text)
        };
        r.map_err(js_error)
    }

    pub fn message(&mut self, uid: u16, text: &str) -> Result<u32, JsValue> {
        self.s.message(uid, text).map_err(js_error)
    }

    #[wasm_bindgen(js_name = userList)]
    pub fn user_list(&mut self) -> Result<u32, JsValue> {
        self.s.user_list().map_err(js_error)
    }

    #[wasm_bindgen(js_name = userInfo)]
    pub fn user_info(&mut self, uid: u16) -> Result<u32, JsValue> {
        self.s.user_info(uid).map_err(js_error)
    }

    #[wasm_bindgen(js_name = setNick)]
    pub fn set_nick(&mut self, nick: &str, icon: u16) -> Result<u32, JsValue> {
        self.s.set_nick(nick, icon).map_err(js_error)
    }

    /// The folder at `path`, an array of each component's bytes as a
    /// listing gave them.
    #[wasm_bindgen(js_name = fileList)]
    pub fn file_list(&mut self, path: &js_sys::Array) -> Result<u32, JsValue> {
        self.s
            .file_list_raw(&slices(&raw_path(path)))
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = newsFile)]
    pub fn news_file(&mut self) -> Result<u32, JsValue> {
        self.s.news_file().map_err(js_error)
    }

    #[wasm_bindgen(js_name = newsListing)]
    pub fn news_listing(&mut self, path: &js_sys::Array) -> Result<u32, JsValue> {
        self.s
            .news_listing_raw(&slices(&raw_path(path)))
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = newsCategory)]
    pub fn news_category(&mut self, path: &js_sys::Array) -> Result<u32, JsValue> {
        self.s
            .news_category_raw(&slices(&raw_path(path)))
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = newsArticle)]
    pub fn news_article(&mut self, path: &js_sys::Array, id: u32) -> Result<u32, JsValue> {
        self.s
            .news_article_raw(&slices(&raw_path(path)), id)
            .map_err(js_error)
    }

    /// Text as this session sends it, for a path typed rather than listed.
    pub fn encode(&self, text: &str) -> Vec<u8> {
        self.s.encode(text)
    }

    /// The trans the login's user list went out on, once it has.
    #[wasm_bindgen(js_name = rosterTrans)]
    pub fn roster_trans(&self) -> Option<u32> {
        self.s.roster_trans()
    }
}
