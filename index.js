// Sophon Voice Call: a full-duplex voice call with the current character, for SillyTavern.
// Talks to a Sophon-Realtime server over its OpenAI-Realtime-style WebSocket (/v1/realtime):
// your own server (any Tag / Flash / E2E build, 32B or 4B) or the Adventists API.
// The model hears you directly, decides by itself when you have finished, and can be interrupted.

const MODULE = 'sophon_call';
const VERSION = '0.1.1';
const API_HOSTS = { global: 'wss://api.adventists.ai', cn: 'wss://api.adventists.cn' };
const CONSOLE_URLS = { global: 'https://api.adventists.ai/console', cn: 'https://api.adventists.cn/console' };
const REPO_URL = 'https://github.com/adventists-ai/sophon-realtime';
const BUILTIN_VOICES = ['chelsie', 'vivian_zh', 'brand_zh', 'brand_en', 'ryan_en'];
const MODELS = { 'sophon-realtime-tag': 'Tag', 'sophon-realtime-flash': 'Flash', 'sophon-realtime-e2e': 'E2E' };
const IN_RATE = 16000;          // microphone audio sent to the server
const CHUNK = 1600;             // 100 ms per append
const RESTART_GAP_MS = 500;     // a pause this long inside one reply's stream, with the user talking, means the server started it again
const TAG_RE = /\[[a-z_ ]+\]|<[^>]+>/gi;

const DEFAULTS = {
    connection: 'local',        // 'local' | 'api'
    localUrl: 'http://127.0.0.1:8000',
    region: 'global',           // 'global' | 'cn'
    apiKey: '',
    orgId: '',
    model: 'sophon-realtime-tag',
    language: 'auto',           // 'auto' | 'zh' | 'en'
    voice: 'chelsie',
    voices: {},                 // character avatar -> voice
    historyMessages: 10,
    maxPersonaChars: 2000,
    writeToChat: true,
    transcribeUser: false,
    temperature: 0.8,
};

// ------------------------------------------------------------------ i18n
const ZH = /^zh/i.test(String(localStorage.getItem('language') || navigator.language || 'en'));
const T = (zh, en) => (ZH ? zh : en);

// ------------------------------------------------------------------ settings
const ctx = () => SillyTavern.getContext();

function settings() {
    const all = ctx().extensionSettings;
    if (!all[MODULE] || typeof all[MODULE] !== 'object') all[MODULE] = {};
    const s = all[MODULE];                     // one object, changed in place: handlers keep a reference to it
    for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined) s[k] = v;
    if (!s.voices || typeof s.voices !== 'object') s.voices = {};
    return s;
}

function save() {
    ctx().saveSettingsDebounced();
}

function currentCharacter() {
    const c = ctx();
    if (c.groupId) return null;
    const ch = c.characters?.[c.characterId];
    return ch || null;
}

function langOf(s) {
    if (s.language === 'zh' || s.language === 'en') return s.language;
    return ZH ? 'zh' : 'en';
}

function voiceFor(s, ch) {
    return (ch && s.voices[ch.avatar]) || s.voice || 'chelsie';
}

function realtimeUrl(s) {
    if (s.connection === 'api') {
        return `${API_HOSTS[s.region] || API_HOSTS.global}/sophon/v1/realtime?model=${encodeURIComponent(s.model)}`;
    }
    let u = String(s.localUrl || '').trim().replace(/\/+$/, '');
    if (!u) throw new Error(T('请先填写本地服务器地址', 'Set the server address first'));
    if (!/^[a-z]+:\/\//i.test(u)) u = 'http://' + u;
    u = u.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    if (!/\/v1\/realtime$/.test(u)) u += '/v1/realtime';
    return u;
}

function subprotocols(s) {
    if (s.connection !== 'api') return undefined;
    const key = String(s.apiKey || '').trim();
    if (!key) throw new Error(T('请先填写 API key', 'Set your API key first'));
    const p = ['realtime', `openai-insecure-api-key.${key}`];
    if (s.orgId && s.orgId.trim()) p.push(`openai-organization.${s.orgId.trim()}`);
    return p;
}

// ------------------------------------------------------------------ persona + history
function clip(t, n) {
    t = String(t || '').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
}

function plain(t) {
    return String(t || '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// The server may start a reply, drop it and start again under the same id; its text then begins with a dropped fragment
// that the full text repeats ("I think I think that…"). Keep the text from the restart on.
function dedupeRestart(t) {
    for (let k = 4; k <= t.length / 2; k++) {
        const head = t.slice(0, k);
        if (/\S/.test(head) && t.startsWith(head, k)) return t.slice(k);
    }
    return t;
}

function spoken(t) {
    let x = plain(t).replace(/\*[^*\n]*\*/g, ' ').replace(/\([^)\n]*\)|（[^）\n]*）/g, ' ');
    const q = x.match(/"[^"\n]+"|“[^”\n]+”|「[^」\n]+」/g);
    if (q && q.join('').length > 0.3 * x.replace(/\s/g, '').length) x = q.map((y) => y.slice(1, -1)).join(' ');
    return x.replace(/\s+/g, ' ').trim();
}

function buildInstructions(s, lang) {
    const c = ctx();
    const f = c.getCharacterCardFields ? c.getCharacterCardFields() : {};
    // card text often holds sample replies full of *actions*; they are dropped so the voice does not read narration aloud
    const sub = (x) => plain(c.substituteParams ? c.substituteParams(x || '') : x || '').replace(/\*[^*\n]*\*/g, ' ').replace(/[ \t]{2,}/g, ' ');
    const char = c.name2, user = c.name1;
    const head = lang === 'zh'
        ? `你是${char}，正在和${user}打语音电话。你会直接听到对方的声音，你说的每个字都会被直接念出来。像打电话一样用自然的口语回应，一般一两句话；只写要说出口的话，不要写动作、神态、星号或括号里的旁白（例如 *她笑了笑*）、表情或格式符号；数字和符号写成口语的念法。需要时可以用声音标签表现笑声、叹气和重读。始终用${char}的身份、性格和说话方式来聊，不要跳出角色。`
        : `You are ${char}, on a voice call with ${user}. You hear ${user}'s voice directly, and every word you write is spoken aloud. Answer the way people talk on the phone, usually in one or two natural spoken sentences. Write only the words to be spoken: no actions, stage directions, narration in asterisks or brackets (like *smiles*), quotation marks, emoji or formatting; write numbers and symbols the way they are read aloud. When it fits, you may use sound tags for laughter, sighs and emphasis. Always stay in character as ${char}, with ${char}'s personality and way of speaking.`;
    const L = lang === 'zh'
        ? { d: `${char}的设定`, p: '性格', sc: '场景', u: `${user}的设定`, sys: '补充说明' }
        : { d: `About ${char}`, p: 'Personality', sc: 'Scenario', u: `About ${user}`, sys: 'Additional notes' };
    const parts = [
        [L.d, sub(f.description)], [L.p, sub(f.personality)], [L.sc, sub(f.scenario)],
        [L.u, sub(f.persona)], [L.sys, sub(f.system)],
    ].filter(([, v]) => v);
    let budget = Math.max(200, Number(s.maxPersonaChars) || DEFAULTS.maxPersonaChars);
    const body = [];
    for (const [k, v] of parts) {
        if (budget <= 40) break;
        const t = clip(v, budget);
        body.push(lang === 'zh' ? `【${k}】\n${t}` : `## ${k}\n${t}`);
        budget -= t.length;
    }
    const tail = lang === 'zh'
        ? '你们之前在用文字聊天，最近的聊天记录在对话历史里；现在换成了语音通话，自然地接着聊。记住：只说台词，不要描述动作和神态。'
        : 'You were chatting in text before; the latest messages are in the conversation history. Now you are on a voice call: carry on naturally. Remember: say only your lines; never describe actions, looks or surroundings.';
    return [head, ...body, tail].join('\n\n');
}

function buildHistory(s) {
    const c = ctx();
    const n = Math.max(0, Math.min(50, Number(s.historyMessages) || 0));
    if (!n) return [];
    const out = [];
    let total = 0;
    for (let i = c.chat.length - 1; i >= 0 && out.length < n; i--) {
        const m = c.chat[i];
        if (!m || m.is_system || !m.mes) continue;
        // roleplay text: *actions* and narration are dropped, only what was said is kept, so the voice model does not imitate the narration
        const text = clip(spoken(m.mes), 400);
        if (!text) continue;
        total += text.length;
        if (total > 2400) break;
        out.unshift({ role: m.is_user ? 'user' : 'assistant', text });
    }
    return out;
}

// ------------------------------------------------------------------ chat write-back
async function addMessage(kind, text) {
    const c = ctx();
    const msg = {
        name: kind === 'user' ? c.name1 : kind === 'char' ? c.name2 : 'Sophon',
        is_user: kind === 'user',
        is_system: kind === 'note',
        send_date: new Date().toISOString(),
        mes: text,
        extra: { sophon_call: true, ...(kind === 'note' ? { isSmallSys: true } : {}) },
    };
    c.chat.push(msg);
    c.addOneMessage(msg);
    await c.saveChat();
}

// ------------------------------------------------------------------ the call
const WORKLET = `class SophonCap extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('sophon-cap',SophonCap)`;

function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
}

class Call {
    constructor(s, ch) {
        this.s = s;
        this.ch = ch;
        this.lang = langOf(s);
        this.voice = voiceFor(s, ch);
        this.chatId = ctx().getCurrentChatId();
        this.replies = new Map();           // response id -> {text, dur, t0, end, done, cut, timer, written}
        this.rid = null;                    // newest reply
        this.sources = new Set();
        this.playT = 0;
        this.muted = false;
        this.ended = false;
        this.vad = false;                   // the server hears the user speaking
        this.vadAt = 0;
        this.vadEnd = 0;
        this.lines = 0;
        this.t0 = Date.now();
        this.queue = Promise.resolve();     // chat writes, in order
    }

    async start() {
        ui.open(this);
        ui.status(T('正在连接…', 'Connecting…'));
        const url = realtimeUrl(this.s);
        const protos = subprotocols(this.s);
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
        this.actx = new AudioContext();
        await this.actx.resume();
        this.out = this.actx.createGain();
        this.out.connect(this.actx.destination);
        await this.actx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
        this.src = this.actx.createMediaStreamSource(this.stream);
        this.node = new AudioWorkletNode(this.actx, 'sophon-cap');
        this.src.connect(this.node);
        this.acc = new Float32Array(CHUNK);
        this.accN = 0;
        this.pos = 0;
        this.prev = 0;
        this.ratio = this.actx.sampleRate / IN_RATE;
        this.node.port.onmessage = (e) => this.onMic(e.data);

        this.ws = protos ? new WebSocket(url, protos) : new WebSocket(url);
        this.opened = false;
        this.ws.onopen = () => {
            this.opened = true;
            this.sendSession();
        };
        this.ws.onmessage = (e) => {
            try { this.onEvent(JSON.parse(e.data)); } catch (err) { console.warn('[sophon] bad event', err); }
        };
        this.ws.onclose = (e) => {
            if (this.ended) return;
            const why = this.opened
                ? T('连接已断开', 'Disconnected') + (e.reason ? `：${e.reason}` : '')
                : (this.s.connection === 'api'
                    ? T('连不上：请检查 API key，以及这个版本是否已开通', 'Could not connect: check your API key and that this model is enabled for you')
                    : T('连不上本地服务器：请确认它已启动、地址正确', 'Could not reach your server: check that it is running and the address is right'));
            this.end(why);
        };
        if (this.s.transcribeUser) this.startRecognition();
        this.timer = setInterval(() => ui.tick(this), 250);
    }

    sendSession() {
        const session = {
            modalities: ['audio', 'text'],
            voice: this.voice,
            instructions: buildInstructions(this.s, this.lang),
            input_audio_format: 'pcm_f32le',
            output_audio_format: 'pcm16',
            turn_detection: { type: 'server_vad' },
            temperature: Number(this.s.temperature) || 0.8,
            max_tokens: 300,
            extra_body: { auto_response: true, language: this.lang, history: buildHistory(this.s) },
        };
        this.ws.send(JSON.stringify({ type: 'session.update', session }));
    }

    onMic(x) {
        if (this.ended) return;
        let s2 = 0;
        for (let i = 0; i < x.length; i++) s2 += x[i] * x[i];
        ui.level(this.muted ? 0 : Math.sqrt(s2 / x.length));
        // linear resample to 16 kHz; keep streaming (silence when muted): the model needs the continuous stream to judge pauses
        const r = this.ratio;
        let pos = this.pos;
        while (pos < x.length) {
            const i = Math.floor(pos), f = pos - i;
            const a = i === 0 ? this.prev : x[i - 1], b = x[i];
            this.acc[this.accN++] = this.muted ? 0 : a + (b - a) * f;
            if (this.accN === CHUNK) this.flush();
            pos += r;
        }
        this.pos = pos - x.length;
        this.prev = x[x.length - 1];
    }

    flush() {
        const buf = this.acc.slice(0, this.accN);
        this.accN = 0;
        if (!this.ws || this.ws.readyState !== 1 || !this.ready) return;
        this.ws.send(JSON.stringify({
            type: 'input_audio_buffer.append', audio: b64(new Uint8Array(buf.buffer)), format: 'pcm_f32le', sample_rate_hz: IN_RATE,
        }));
    }

    reply(rid) {
        if (!this.replies.has(rid)) this.replies.set(rid, this.fresh());
        return this.replies.get(rid);
    }

    fresh() {
        return { text: '', dur: 0, t0: null, end: 0, done: false, cut: false, timer: null, written: false, last: 0 };
    }

    // The record that a delta of reply `rid` belongs to, or null to ignore it.
    // The server can restart a reply under the same id: when it answered a pause and the user went on talking, it drops that
    // answer and starts again; after a barge-in it may go on with a new answer. A restart shows as a pause in the stream.
    segment(rid) {
        const now = performance.now();
        let r = this.reply(rid);
        const gap = r.last ? now - r.last : 0;
        if (r.cut) {
            if (gap < RESTART_GAP_MS) { r.last = now; return null; }      // the rest of a reply that was cut off
            r = this.restart(rid, false);
        } else if (r.last && gap >= RESTART_GAP_MS && (this.vad || this.vadAt > r.last || this.vadEnd > r.last)) {
            r = this.restart(rid, true);                                  // the earlier answer was dropped by the server
        }
        r.last = now;
        return r;
    }

    restart(rid, stopOld) {
        const old = this.reply(rid);
        if (stopOld) {
            this.stopAudio();
            if (old.timer) clearTimeout(old.timer);
            old.written = true;           // the server dropped it from the conversation, so it is not written either
        }
        const r = this.fresh();
        this.replies.set(rid, r);
        console.debug('[sophon] reply restarted', stopOld ? '(dropped answer)' : '(after barge-in)');
        return r;
    }

    speaking() {
        return this.actx && this.playT > this.actx.currentTime + 0.02;
    }

    onEvent(e) {
        const t = e.type || '';
        const rid = e.response_id || e.response?.id || null;
        switch (t) {
            case 'session.created':
            case 'session.updated':
                if (!this.ready) {
                    this.ready = true;
                    ui.status(T('通话中，直接说话', 'Connected: just talk'));
                }
                break;
            case 'input_audio_buffer.speech_started':
                // the protocol's "stop playing" signal: the server has cut the reply where it thinks you heard it
                this.vad = true;
                this.vadAt = performance.now();
                if (this.speaking()) this.barge('speech');
                ui.state('hearing');
                break;
            case 'input_audio_buffer.speech_stopped':
                this.vad = false;
                this.vadEnd = performance.now();
                ui.state(this.speaking() ? 'speaking' : 'thinking');
                break;
            case 'audio.cancelled':
                this.barge('server');
                break;
            case 'response.created':
                if (rid) this.newReply(rid);
                break;
            case 'response.output_audio.delta': {
                const id = rid || this.rid;
                if (!id || !e.delta) break;
                if (id !== this.rid) this.newReply(id);
                const r = this.segment(id);
                if (r) this.play(r, e.delta, Number(e.sample_rate_hz) || 24000);
                break;
            }
            case 'response.output_audio_transcript.delta':
            case 'response.output_text.delta':
            case 'response.text.delta': {
                const id = rid || this.rid;
                if (!id || !e.delta) break;
                if (id !== this.rid) this.newReply(id);
                const r = this.segment(id);
                if (r) r.text += e.delta;
                break;
            }
            case 'response.done': {
                const id = rid || this.rid;
                if (!id) break;
                const r = this.reply(id);
                r.done = true;
                if (!r.cut) this.scheduleWrite(r);
                break;
            }
            case 'error': {
                const err = e.error || {};
                const code = err.code || '';
                const fatal = ['idle_timeout', 'session_time_limit', 'insufficient_quota', 'invalid_api_key', 'model_not_allowed'].includes(code);
                const msg = {
                    idle_timeout: T('太久没人说话，通话已结束', 'Nobody spoke for a while; the call ended'),
                    session_time_limit: T('已到单次通话时长上限', 'This call reached its time limit'),
                    insufficient_quota: T('余额用完了，请到控制台充值', 'Your balance is used up; top up in the console'),
                    voice_not_found: T('找不到这个音色，已改用默认音色', 'Voice not found; using the default voice'),
                    voice_not_ready: T('克隆音色还在准备中（约 30 秒），已改用默认音色', 'The cloned voice is still being prepared (about 30 s); using the default voice'),
                    voice_not_supported: T('这个版本不支持克隆音色，已改用默认音色', 'This model does not take cloned voices; using the default voice'),
                }[code] || err.message || code || T('服务器报错', 'Server error');
                if (fatal) this.end(msg);
                else toastr.warning(msg, 'Sophon');
                break;
            }
            default:
                break;
        }
    }

    newReply(rid) {
        if (this.rid && this.rid !== rid && this.speaking()) this.barge('new_reply');   // the model moved on: drop what is left of the previous reply
        this.rid = rid;
        this.reply(rid);
        ui.state('thinking');
    }

    play(r, b64data, rate) {
        if (this.ended) return;
        const bin = atob(b64data);
        const n = bin.length >> 1;
        if (!n) return;
        const f = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
            if (v >= 0x8000) v -= 0x10000;
            f[i] = v / 32768;
        }
        const buf = this.actx.createBuffer(1, n, rate);
        buf.copyToChannel(f, 0);
        const node = this.actx.createBufferSource();
        node.buffer = buf;
        node.connect(this.out);
        const now = this.actx.currentTime;
        if (this.playT < now + 0.03) this.playT = now + (r.t0 === null ? 0.15 : 0.06);   // small preroll at the start of a reply
        node.start(this.playT);
        if (r.t0 === null) {
            r.t0 = this.playT;
            setTimeout(() => { if (this.reply(this.rid) === r && !r.cut) { ui.state('speaking'); ui.subtitle(r); } }, Math.max(0, (r.t0 - now) * 1000));
        }
        this.playT += buf.duration;
        r.dur += buf.duration;
        r.end = this.playT;
        this.sources.add(node);
        node.onended = () => this.sources.delete(node);
        if (this.reply(this.rid) === r) ui.subtitle(r, true);
    }

    stopAudio() {
        for (const n of this.sources) { try { n.stop(); } catch (err) { /* already stopped */ } }
        this.sources.clear();
        this.playT = this.actx.currentTime;
    }

    barge(why) {
        if (!this.actx) return;
        const now = this.actx.currentTime;
        this.stopAudio();
        if (!this.rid) return;
        const r = this.reply(this.rid);
        if (r.cut || r.written) return;
        r.cut = true;
        r.last = performance.now();
        r.played = r.t0 === null ? 0 : Math.max(0, Math.min(r.dur, now - r.t0));
        if (r.timer) clearTimeout(r.timer);
        this.writeReply(r);
        ui.state('hearing');
        console.debug('[sophon] barge-in', why, r.played.toFixed(2), '/', r.dur.toFixed(2));
    }

    scheduleWrite(r) {
        const wait = Math.max(0, (r.end - this.actx.currentTime) * 1000);
        if (r.timer) clearTimeout(r.timer);
        r.timer = setTimeout(() => {
            this.writeReply(r);
            if (this.reply(this.rid) === r && !this.speaking()) ui.state('listening');
        }, wait + 50);
    }

    writeReply(r) {
        if (r.written) return;
        r.written = true;
        let text = dedupeRestart(r.text.replace(TAG_RE, '').replace(/\s+/g, ' ').trim());
        if (r.cut) {
            const frac = r.dur > 0 ? r.played / r.dur : 0;
            if (r.played < 0.4 || !text) return;
            const k = Math.max(1, Math.round(text.length * frac));
            text = k < text.length ? text.slice(0, k).trimEnd() + (/[\u3400-\u9fff]/.test(text) ? '——' : '—') : text;
        }
        if (!text || !this.s.writeToChat || this.ended) return;
        this.write('char', text);
    }

    write(kind, text) {
        if (ctx().getCurrentChatId() !== this.chatId) return;
        this.lines++;
        this.queue = this.queue.then(() => addMessage(kind, text)).catch((err) => console.warn('[sophon] write failed', err));
    }

    startRecognition() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            toastr.info(T('这个浏览器不支持语音识别，你说的话不会写进聊天记录', 'This browser has no speech recognition; your side will not be written to the chat'), 'Sophon');
            return;
        }
        const rec = new SR();
        rec.lang = this.lang === 'zh' ? 'zh-CN' : 'en-US';
        rec.continuous = true;
        rec.interimResults = false;
        rec.onresult = (ev) => {
            for (let i = ev.resultIndex; i < ev.results.length; i++) {
                const res = ev.results[i];
                const text = res.isFinal && res[0] ? res[0].transcript.trim() : '';
                if (text && this.s.writeToChat && !this.ended) this.write('user', text);
            }
        };
        rec.onend = () => { if (!this.ended) { try { rec.start(); } catch (err) { /* restarting too fast */ } } };
        rec.onerror = (ev) => { if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') this.rec = null; };
        try { rec.start(); this.rec = rec; } catch (err) { console.warn('[sophon] recognition', err); }
    }

    toggleMute() {
        this.muted = !this.muted;
        return this.muted;
    }

    end(reason) {
        if (this.ended) return;
        // a reply still playing when the user hangs up: keep what was heard
        if (this.rid && this.actx) {
            const r = this.reply(this.rid);
            if (!r.written && r.t0 !== null) {
                if (this.speaking()) this.barge('hangup');
                else this.writeReply(r);
            }
        }
        this.ended = true;
        clearInterval(this.timer);
        for (const r of this.replies.values()) if (r.timer) clearTimeout(r.timer);
        try { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'session.close' })); } catch (err) { /* closing */ }
        try { this.ws && this.ws.close(); } catch (err) { /* closing */ }
        try { this.rec && this.rec.abort(); } catch (err) { /* stopped */ }
        try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch (err) { /* stopped */ }
        try { this.node && this.node.disconnect(); } catch (err) { /* stopped */ }
        try { this.actx && this.actx.close(); } catch (err) { /* closed */ }
        const secs = Math.round((Date.now() - this.t0) / 1000);
        if (this.lines && this.s.writeToChat) {
            const mm = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
            this.queue = this.queue.then(() => addMessage('note', T(`📞 语音通话结束 · ${mm}`, `📞 Voice call ended · ${mm}`))).catch(() => {});
        }
        ui.close(reason);
        if (call === this) call = null;
    }
}

let call = null;

async function startCall() {
    if (call) return;
    const ch = currentCharacter();
    if (!ch) {
        toastr.info(T('请先打开一个角色的聊天（暂不支持群聊）', 'Open a chat with a character first (group chats are not supported yet)'), 'Sophon');
        return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices) {
        toastr.error(T('浏览器只在 https 或 localhost 下允许用麦克风。请用 http://localhost:8000 打开 SillyTavern，或给它配上 https。', 'Browsers only allow the microphone on https or localhost. Open SillyTavern at http://localhost:8000, or serve it over https.'), 'Sophon');
        return;
    }
    const s = settings();
    call = new Call(s, ch);
    try {
        await call.start();
    } catch (err) {
        const msg = err && err.name === 'NotAllowedError' ? T('没有麦克风权限', 'Microphone permission denied') : String(err && err.message || err);
        if (call) call.end(msg);
    }
}

// ------------------------------------------------------------------ call panel
const ui = {
    el: null,
    build() {
        if (this.el) return;
        const el = document.createElement('div');
        el.id = 'sophon_call_panel';
        el.className = 'sophon-call';
        el.hidden = true;
        el.innerHTML = `
            <div class="sc-top">
                <img class="sc-avatar" alt="">
                <div class="sc-who"><div class="sc-name"></div><div class="sc-status"></div></div>
                <div class="sc-timer">0:00</div>
            </div>
            <div class="sc-sub"></div>
            <div class="sc-meter"><i></i></div>
            <div class="sc-btns">
                <button class="sc-mute menu_button" title="${T('静音', 'Mute')}"><i class="fa-solid fa-microphone"></i></button>
                <button class="sc-hang menu_button" title="${T('挂断', 'Hang up')}"><i class="fa-solid fa-phone-slash"></i></button>
            </div>`;
        document.body.appendChild(el);
        el.querySelector('.sc-hang').addEventListener('click', () => call && call.end(''));
        el.querySelector('.sc-mute').addEventListener('click', (ev) => {
            if (!call) return;
            const m = call.toggleMute();
            ev.currentTarget.classList.toggle('sc-on', m);
            ev.currentTarget.querySelector('i').className = m ? 'fa-solid fa-microphone-slash' : 'fa-solid fa-microphone';
        });
        this.el = el;
    },
    open(c) {
        this.build();
        const el = this.el;
        const x = ctx();
        el.querySelector('.sc-avatar').src = c.ch.avatar ? x.getThumbnailUrl('avatar', c.ch.avatar) : '';
        const where = c.s.connection === 'api' ? MODELS[c.s.model] || c.s.model : T('本地', 'local');
        el.querySelector('.sc-name').textContent = `${x.name2} · ${where}`;
        el.querySelector('.sc-sub').textContent = '';
        el.querySelector('.sc-timer').textContent = '0:00';
        el.querySelector('.sc-mute').classList.remove('sc-on');
        el.querySelector('.sc-mute i').className = 'fa-solid fa-microphone';
        el.dataset.state = 'connecting';
        el.hidden = false;
    },
    status(t) { if (this.el) this.el.querySelector('.sc-status').textContent = t; },
    state(st) {
        if (!this.el) return;
        this.el.dataset.state = st;
        const label = { listening: T('在听', 'Listening'), hearing: T('在听你说', 'Hearing you'), thinking: T('在想', 'Thinking'), speaking: T('在说', 'Speaking') }[st];
        if (label) this.status(label);
    },
    subtitle(r, update) {
        if (!this.el || (update && this.el.dataset.state !== 'speaking')) return;
        const t = dedupeRestart(r.text.replace(TAG_RE, '').trim());
        this.el.querySelector('.sc-sub').textContent = t;
    },
    level(v) { if (this.el) this.el.querySelector('.sc-meter i').style.width = Math.min(100, v * 600) + '%'; },
    tick(c) {
        if (!this.el) return;
        const s = Math.round((Date.now() - c.t0) / 1000);
        this.el.querySelector('.sc-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        if (c.ready && !c.speaking() && this.el.dataset.state === 'speaking') this.state('listening');
        else if (c.speaking() && !c.vad && this.el.dataset.state !== 'speaking') { this.state('speaking'); this.subtitle(c.reply(c.rid)); }
    },
    close(reason) {
        if (!this.el) return;
        this.el.hidden = true;
        if (reason) toastr.info(reason, 'Sophon');
    },
};

// ------------------------------------------------------------------ settings panel
function settingsHtml() {
    const s = settings();
    const opt = (v, label, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`;
    return `
<div class="sophon-call-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>${T('Sophon 语音通话', 'Sophon Voice Call')}</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <small>${T('和当前角色打一通全双工语音电话：模型直接听你说话，自己判断你什么时候说完，可以随时打断。',
        'A full-duplex voice call with the current character: the model hears you directly, decides by itself when you have finished, and can be interrupted at any time.')}</small>

      <label for="sc_conn">${T('连接方式', 'Connect to')}</label>
      <select id="sc_conn" class="text_pole">
        ${opt('local', T('我自己部署的服务器', 'My own server'), s.connection)}
        ${opt('api', T('Adventists API（官方接口）', 'Adventists API'), s.connection)}
      </select>

      <div class="sc-local">
        <label for="sc_url">${T('服务器地址', 'Server address')}</label>
        <input id="sc_url" class="text_pole" type="text" placeholder="http://127.0.0.1:8000" value="${s.localUrl}">
        <small>${T('任意 Sophon-Realtime 服务器（Tag / Flash / E2E，32B 或 4B）。4B 版一张 24 GB 显卡就能跑，部署见',
            'Any Sophon-Realtime server (Tag / Flash / E2E, 32B or 4B). The 4B builds run on one 24 GB GPU; setup:')}
          <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a></small>
      </div>

      <div class="sc-api">
        <label for="sc_region">${T('接入点', 'Endpoint')}</label>
        <select id="sc_region" class="text_pole">
          ${opt('global', T('海外 api.adventists.ai', 'Global: api.adventists.ai'), s.region)}
          ${opt('cn', T('国内 api.adventists.cn', 'Mainland China: api.adventists.cn'), s.region)}
        </select>
        <label for="sc_key">API key</label>
        <input id="sc_key" class="text_pole" type="password" autocomplete="off" placeholder="sk-sophon-…" value="${s.apiKey}">
        <small>${T('还没有 key？到', 'No key yet? Get one in the')}
          <a id="sc_console" href="${CONSOLE_URLS[s.region] || CONSOLE_URLS.global}" target="_blank" rel="noopener">${T('控制台', 'console')}</a>${T('用邮箱注册后申请。key 保存在你自己的 SillyTavern 设置里，只从你的浏览器直接发给 Adventists。',
            ' (sign up with your email). The key is kept in your own SillyTavern settings and sent only from your browser to Adventists.')}</small>
        <label for="sc_model">${T('版本', 'Model')}</label>
        <select id="sc_model" class="text_pole">
          ${opt('sophon-realtime-tag', T('Tag：表现力最好（笑、叹气、重读）', 'Tag: most expressive (laughs, sighs, stress)'), s.model)}
          ${opt('sophon-realtime-flash', T('Flash：最快', 'Flash: fastest'), s.model)}
          ${opt('sophon-realtime-e2e', T('E2E：端到端语音，情绪自然', 'E2E: end-to-end speech, natural emotion'), s.model)}
        </select>
      </div>

      <label for="sc_voice">${T('当前角色的音色', "This character's voice")}</label>
      <div class="flex-container">
        <select id="sc_voice_pick" class="text_pole flex1"></select>
        <input id="sc_voice" class="text_pole flex1" type="text" placeholder="${T('克隆音色 id 或自定义名', 'cloned voice id or custom name')}">
      </div>
      <small>${T('每个角色单独记住。内置音色任何服务器都能用。', 'Remembered per character. Built-in voices work on every server.')}</small>
      <small class="sc-local">${T('克隆声音：把同一个人 3–10 秒的干净录音（E2E 要 5–12 秒）放进服务器的 <code>model/voices/</code>（如 <code>alice.wav</code>），选「其他…」填 <code>alice</code>，下一通电话生效，录音不出本机。',
        'Clone a voice: put a 3–10 s clip of one speaker (5–12 s for E2E) into your server\'s <code>model/voices/</code> (e.g. <code>alice.wav</code>), then choose Other… and type <code>alice</code>. It takes effect on the next call, and the clip stays on your machine.')}
        <a href="${REPO_URL}/blob/main/tag/README.md#zero-shot-voice-cloning" target="_blank" rel="noopener">${T('详情', 'Details')}</a></small>
      <small class="sc-api">${T('克隆声音：在', 'Clone a voice: record or upload 3–15 s in the')}
        <a id="sc_console_voices" href="${CONSOLE_URLS[s.region] || CONSOLE_URLS.global}" target="_blank" rel="noopener">${T('控制台', 'console')}</a>${T('的「音色」页录音或上传 3–15 秒，把 <code>voice_…</code> id 粘贴到「其他…」里（Tag、Flash、E2E 都能用）。',
        "'s Voices tab, then paste its <code>voice_…</code> id under Other… (works with Tag, Flash and E2E).")}</small>
      <small>${T('只克隆你本人或已获授权的声音。', 'Only clone your own voice, or a voice you have permission to use.')}</small>

      <label for="sc_lang">${T('语言', 'Language')}</label>
      <select id="sc_lang" class="text_pole">
        ${opt('auto', T('跟随界面语言', 'Same as the interface'), s.language)}
        ${opt('zh', '中文', s.language)}
        ${opt('en', 'English', s.language)}
      </select>

      <label for="sc_hist">${T('带上最近几条聊天记录', 'Recent chat messages to include')}</label>
      <input id="sc_hist" class="text_pole" type="number" min="0" max="50" value="${s.historyMessages}">

      <label class="checkbox_label"><input id="sc_write" type="checkbox"${s.writeToChat ? ' checked' : ''}>
        <span>${T('把角色说的话写进聊天记录', "Write the character's lines to the chat")}</span></label>
      <label class="checkbox_label"><input id="sc_stt" type="checkbox"${s.transcribeUser ? ' checked' : ''}>
        <span>${T('也把我说的话写进去（用浏览器自带的语音识别，Chrome / Edge；识别由浏览器厂商的服务完成）',
          "Also write my side (the browser's own speech recognition, Chrome / Edge; it runs on the browser vendor's service)")}</span></label>

      <div class="flex-container">
        <div id="sc_test" class="menu_button">${T('测试连接', 'Test connection')}</div>
        <div id="sc_call" class="menu_button">${T('开始通话', 'Start call')}</div>
      </div>
      <small id="sc_test_out"></small>
      <small>${T('建议戴耳机：外放的声音会被麦克风收进去，模型会以为你在说话。', 'Use headphones: without them the microphone picks up the reply and the model may think you are talking.')}</small>
    </div>
  </div>
</div>`;
}

function refreshVoiceInputs() {
    const s = settings();
    const ch = currentCharacter();
    const v = voiceFor(s, ch);
    const pick = document.getElementById('sc_voice_pick');
    const txt = document.getElementById('sc_voice');
    if (!pick || !txt) return;
    pick.innerHTML = BUILTIN_VOICES.map((b) => `<option value="${b}">${b}</option>`).join('') + `<option value="__custom">${T('其他…', 'Other…')}</option>`;
    if (BUILTIN_VOICES.includes(v)) {
        pick.value = v;
        txt.value = '';
        txt.style.display = 'none';
    } else {
        pick.value = '__custom';
        txt.value = v;
        txt.style.display = '';
    }
    pick.disabled = txt.disabled = !ch;
}

function setVoice(v) {
    const s = settings();
    const ch = currentCharacter();
    if (!ch) return;
    v = String(v || '').trim();
    if (v) s.voices[ch.avatar] = v;
    else delete s.voices[ch.avatar];
    save();
}

function showConnFields() {
    const s = settings();
    $('.sophon-call-settings .sc-local').toggle(s.connection === 'local');
    $('.sophon-call-settings .sc-api').toggle(s.connection === 'api');
}

async function testConnection() {
    const out = document.getElementById('sc_test_out');
    const s = settings();
    out.textContent = T('连接中…', 'Connecting…');
    let ws;
    const t0 = performance.now();
    try {
        const p = subprotocols(s);
        ws = p ? new WebSocket(realtimeUrl(s), p) : new WebSocket(realtimeUrl(s));
    } catch (err) {
        out.textContent = String(err.message || err);
        return;
    }
    const done = (msg) => { out.textContent = msg; try { ws.close(); } catch (err) { /* closed */ } };
    const timer = setTimeout(() => done(T('超时：服务器没有回应', 'Timed out: no answer from the server')), 10000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'session.update', session: { modalities: ['audio', 'text'], turn_detection: { type: 'server_vad' }, extra_body: { auto_response: true, language: langOf(s) } } }));
    ws.onmessage = (e) => {
        let ev = {};
        try { ev = JSON.parse(e.data); } catch (err) { return; }
        if (ev.type === 'session.created' || ev.type === 'session.updated') {
            clearTimeout(timer);
            done(T(`连接成功（${Math.round(performance.now() - t0)} ms）`, `Connected (${Math.round(performance.now() - t0)} ms)`));
        } else if (ev.type === 'error') {
            clearTimeout(timer);
            done(T('服务器报错：', 'Server error: ') + ((ev.error && (ev.error.message || ev.error.code)) || ''));
        }
    };
    ws.onclose = () => {
        clearTimeout(timer);
        if (out.textContent === T('连接中…', 'Connecting…')) {
            out.textContent = s.connection === 'api'
                ? T('连不上：请检查 API key，以及这个版本是否已开通', 'Could not connect: check your API key and that this model is enabled for you')
                : T('连不上本地服务器：请确认它已启动、地址正确', 'Could not reach your server: check that it is running and the address is right');
        }
    };
}

function bindSettings() {
    const s = settings();
    const on = (id, ev, fn) => document.getElementById(id).addEventListener(ev, fn);
    on('sc_conn', 'change', (e) => { s.connection = e.target.value; save(); showConnFields(); });
    on('sc_url', 'input', (e) => { s.localUrl = e.target.value; save(); });
    on('sc_region', 'change', (e) => { s.region = e.target.value; document.getElementById('sc_console').href = CONSOLE_URLS[s.region]; document.getElementById('sc_console_voices').href = CONSOLE_URLS[s.region]; save(); });
    on('sc_key', 'input', (e) => { s.apiKey = e.target.value.trim(); save(); });
    on('sc_model', 'change', (e) => { s.model = e.target.value; save(); });
    on('sc_lang', 'change', (e) => { s.language = e.target.value; save(); });
    on('sc_hist', 'input', (e) => { s.historyMessages = Math.max(0, Math.min(50, Number(e.target.value) || 0)); save(); });
    on('sc_write', 'change', (e) => { s.writeToChat = e.target.checked; save(); });
    on('sc_stt', 'change', (e) => { s.transcribeUser = e.target.checked; save(); });
    on('sc_voice_pick', 'change', (e) => {
        const txt = document.getElementById('sc_voice');
        if (e.target.value === '__custom') { txt.style.display = ''; txt.focus(); setVoice(txt.value); }
        else { txt.style.display = 'none'; setVoice(e.target.value); }
    });
    on('sc_voice', 'input', (e) => setVoice(e.target.value));
    on('sc_test', 'click', testConnection);
    on('sc_call', 'click', startCall);
    showConnFields();
    refreshVoiceInputs();
}

// ------------------------------------------------------------------ entry points
function addButtons() {
    const menu = document.getElementById('extensionsMenu');
    if (menu && !document.getElementById('sophon_call_menu')) {
        const item = document.createElement('div');
        item.id = 'sophon_call_menu';
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.tabIndex = 0;
        item.innerHTML = `<div class="fa-solid fa-phone extensionsMenuExtensionButton"></div><span>${T('Sophon 语音通话', 'Sophon voice call')}</span>`;
        item.addEventListener('click', startCall);
        menu.appendChild(item);
    }
    const form = document.getElementById('leftSendForm');
    if (form && !document.getElementById('sophon_call_btn')) {
        const b = document.createElement('div');
        b.id = 'sophon_call_btn';
        b.className = 'fa-solid fa-phone interactable';
        b.title = T('和当前角色语音通话（Sophon）', 'Voice call with this character (Sophon)');
        b.tabIndex = 0;
        b.addEventListener('click', () => (call ? call.end('') : startCall()));
        form.appendChild(b);
    }
}

function registerCommand() {
    const c = ctx();
    try {
        c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
            name: 'sophon-call',
            callback: async (args, value) => {
                if (String(value || '').trim() === 'end') { if (call) call.end(''); } else await startCall();
                return '';
            },
            helpString: T('开始和当前角色的 Sophon 语音通话；/sophon-call end 挂断。', 'Start a Sophon voice call with the current character; /sophon-call end hangs up.'),
        }));
    } catch (err) {
        console.warn('[sophon] slash command not registered', err);
    }
}

jQuery(async () => {
    settings();
    $('#extensions_settings2').append(settingsHtml());
    bindSettings();
    addButtons();
    registerCommand();
    const c = ctx();
    c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => {
        refreshVoiceInputs();
        if (call && ctx().getCurrentChatId() !== call.chatId) call.end(T('聊天已切换，通话结束', 'Chat changed; the call ended'));
    });
    console.log(`[sophon] voice call extension ${VERSION} loaded`);
});
