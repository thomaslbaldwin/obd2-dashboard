'use strict';

const net = require('net');
const { EventEmitter } = require('events');

/**
 * Low-level transport for an ELM327-compatible WiFi adapter.
 *
 * WiFi OBD2 dongles expose a raw TCP socket (typically 192.168.0.10:35000).
 * Commands are ASCII terminated by "\r"; the adapter replies and finishes
 * every response with a ">" prompt. Only one command may be in flight at a
 * time, so commands are serialized through a queue.
 *
 * Events: 'connect', 'close', 'error', 'traffic' ({dir:'tx'|'rx', text})
 */
class Elm327 extends EventEmitter {
  constructor({ host, port, connectTimeout = 8000, commandTimeout = 5000 } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.connectTimeout = connectTimeout;
    this.commandTimeout = commandTimeout;
    this.socket = null;
    this.buffer = '';
    this.queue = [];
    this.current = null;
    this.connected = false;
    this.draining = false;
    this.drainTimer = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.socket) this.destroy();
      const socket = new net.Socket();
      this.socket = socket;
      this.buffer = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`Timed out connecting to ${this.host}:${this.port}`));
      }, this.connectTimeout);

      socket.setNoDelay(true);
      socket.setKeepAlive(true, 5000);

      socket.on('data', (chunk) => this._onData(chunk));

      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connected = true;
        this.emit('connect');
        resolve();
      });

      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
          return;
        }
        this.emit('error', err);
      });

      socket.on('close', () => {
        if (this.socket !== socket) return;
        const wasConnected = this.connected;
        this.connected = false;
        this.socket = null;
        this._failAll(new Error('Connection closed'));
        if (wasConnected) this.emit('close');
      });

      socket.connect(this.port, this.host);
    });
  }

  /**
   * Send a command and resolve with the raw response text (prompt removed).
   * @param {string} cmd e.g. "010C" or "ATZ"
   * @param {object} [opts] { timeout }
   */
  send(cmd, opts = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('Not connected'));
        return;
      }
      this.queue.push({ cmd, resolve, reject, timeout: opts.timeout || this.commandTimeout });
      this._pump();
    });
  }

  close() {
    this._failAll(new Error('Connection closed'));
    if (this.socket) {
      const s = this.socket;
      this.connected = false;
      this.socket = null;
      s.end();
      setTimeout(() => s.destroy(), 500).unref();
      this.emit('close');
    }
  }

  destroy() {
    this._failAll(new Error('Connection destroyed'));
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  // -------------------------------------------------------------------------

  _endDrain() {
    clearTimeout(this.drainTimer);
    this.draining = false;
    this.buffer = '';
    this._pump();
  }

  _pump() {
    if (this.draining || this.current || this.queue.length === 0 || !this.socket) return;
    const item = this.queue.shift();
    this.current = item;
    this.buffer = '';
    item.timer = setTimeout(() => {
      if (this.current !== item) return;
      this.current = null;
      item.reject(new Error(`Timeout waiting for response to ${item.cmd}`));
      // The adapter may still be busy. Interrupt it with a bare CR and wait
      // for its prompt (or a short grace period) before sending anything else,
      // so a late reply is never mistaken for the next command's answer.
      this.draining = true;
      if (this.socket) this.socket.write('\r');
      this.drainTimer = setTimeout(() => this._endDrain(), 1000);
    }, item.timeout);
    this.emit('traffic', { dir: 'tx', text: item.cmd });
    this.socket.write(item.cmd + '\r');
  }

  _onData(chunk) {
    this.buffer += chunk.toString('latin1');
    const idx = this.buffer.indexOf('>');
    if (idx === -1) return;
    const response = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + 1);
    if (this.draining) {
      this._endDrain();
      return;
    }
    const item = this.current;
    if (!item) return; // stray prompt
    clearTimeout(item.timer);
    this.current = null;
    const text = stripEcho(response, item.cmd);
    this.emit('traffic', { dir: 'rx', text });
    item.resolve(text);
    this._pump();
  }

  _failAll(err) {
    clearTimeout(this.drainTimer);
    this.draining = false;
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.reject(err);
      this.current = null;
    }
    const pending = this.queue.splice(0);
    pending.forEach((p) => p.reject(err));
  }
}

/** Remove the echoed command (if echo is on) and surrounding whitespace. */
function stripEcho(response, cmd) {
  let text = response.replace(/\0/g, '');
  const trimmed = text.replace(/^[\r\n\s]+/, '');
  if (trimmed.toUpperCase().startsWith(cmd.toUpperCase())) {
    text = trimmed.slice(cmd.length);
  }
  return text.replace(/^[\r\n\s]+|[\r\n\s]+$/g, '');
}

module.exports = { Elm327, stripEcho };
