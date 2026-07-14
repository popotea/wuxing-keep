// 薄的 PeerJS 包裝。上層(room.ts/lockstep.ts)完全不直接碰 PeerJS API,
// 只透過這裡正規化過的事件與方法溝通,PeerJS 換版本或行為改變時只需要改這一個檔案。

import Peer, { type DataConnection } from 'peerjs';
import { encode, parse, type NetMessage } from './protocol';

export interface IceConfig {
  /** 使用者自己在 openrelay.metered.ca / metered.ca 註冊的免費 TURN 帳密,不要用教學文件裡的共用 demo 帳密 */
  turnUsername?: string;
  turnCredential?: string;
}

const STUN_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

function buildIceServers(cfg: IceConfig): RTCIceServer[] {
  const servers = [...STUN_SERVERS];
  if (cfg.turnUsername && cfg.turnCredential) {
    servers.push({
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: cfg.turnUsername,
      credential: cfg.turnCredential,
    });
  }
  return servers;
}

export type NetErrorType = 'id-taken' | 'peer-unavailable' | 'network' | 'unknown';

export interface NetError {
  type: NetErrorType;
  raw: unknown;
}

export interface NetHandlers {
  /** 房主端:有新的客戶端連進來且 data channel 已經 open */
  onIncomingConnection?: (conn: DataConnection) => void;
  onMessage?: (conn: DataConnection, msg: NetMessage) => void;
  onConnectionClose?: (conn: DataConnection) => void;
  /** open() / join() 成功之後才發生的連線層錯誤(斷線、TURN 失效等) */
  onFatalError?: (err: NetError) => void;
}

interface PeerJsError extends Error {
  type?: string;
}

function normalizeError(raw: PeerJsError): NetError {
  switch (raw.type) {
    case 'unavailable-id':
      return { type: 'id-taken', raw };
    case 'peer-unavailable':
      return { type: 'peer-unavailable', raw };
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
    case 'disconnected':
      return { type: 'network', raw };
    default:
      return { type: 'unknown', raw };
  }
}

export class NetPeer {
  private peer: Peer | null = null;
  private connections = new Map<string, DataConnection>();

  constructor(
    private handlers: NetHandlers,
    private iceConfig: IceConfig = {},
  ) {}

  /** 房主開房:用指定的 peerId(房號)註冊。id 被佔用會 reject NetError{type:'id-taken'}。 */
  open(peerId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const peer = new Peer(peerId, {
        config: { iceServers: buildIceServers(this.iceConfig) },
      });
      this.peer = peer;

      const onOpen = (id: string) => {
        peer.off('error', onError);
        peer.on('connection', (conn) => this.wireIncoming(conn));
        resolve(id);
      };
      const onError = (err: PeerJsError) => {
        peer.off('open', onOpen);
        reject(normalizeError(err));
      };
      peer.once('open', onOpen);
      peer.once('error', onError);

      peer.on('error', (err: PeerJsError) => {
        if (peer.open) this.handlers.onFatalError?.(normalizeError(err));
      });
    });
  }

  /** 客戶端加入房間:用隨機 peerId 註冊自己,再連到房主的 peerId(房號)。 */
  join(myPeerId: string, hostPeerId: string): Promise<DataConnection> {
    return new Promise((resolve, reject) => {
      const peer = new Peer(myPeerId, {
        config: { iceServers: buildIceServers(this.iceConfig) },
      });
      this.peer = peer;

      const onOpenError = (err: PeerJsError) => {
        peer.off('open', onOpen);
        reject(normalizeError(err));
      };
      const onOpen = () => {
        peer.off('error', onOpenError);
        const conn = peer.connect(hostPeerId, { reliable: true });

        const onConnError = (err: PeerJsError) => {
          conn.off('open', onConnOpen);
          reject(normalizeError(err));
        };
        const onConnOpen = () => {
          conn.off('error', onConnError);
          this.wireConnection(conn);
          resolve(conn);
        };
        conn.once('open', onConnOpen);
        conn.once('error', onConnError);

        peer.on('error', (err: PeerJsError) => {
          if (peer.open) this.handlers.onFatalError?.(normalizeError(err));
        });
      };
      peer.once('open', onOpen);
      peer.once('error', onOpenError);
    });
  }

  private wireIncoming(conn: DataConnection): void {
    conn.on('open', () => {
      this.wireConnection(conn);
      this.handlers.onIncomingConnection?.(conn);
    });
  }

  private wireConnection(conn: DataConnection): void {
    this.connections.set(conn.peer, conn);
    conn.on('data', (data: unknown) => {
      const msg = parse(data);
      if (msg) this.handlers.onMessage?.(conn, msg);
    });
    conn.on('close', () => {
      this.connections.delete(conn.peer);
      this.handlers.onConnectionClose?.(conn);
    });
  }

  send(conn: DataConnection, msg: NetMessage): void {
    conn.send(encode(msg));
  }

  /** 房主專用:轉發訊息給所有客戶端(可排除某一個,例如訊息就是他自己送來的)。 */
  broadcast(msg: NetMessage, excludePeerId?: string): void {
    const payload = encode(msg);
    for (const [peerId, conn] of this.connections) {
      if (peerId === excludePeerId) continue;
      conn.send(payload);
    }
  }

  closeConnection(peerId: string): void {
    this.connections.get(peerId)?.close();
    this.connections.delete(peerId);
  }

  destroy(): void {
    this.peer?.destroy();
    this.peer = null;
    this.connections.clear();
  }
}
