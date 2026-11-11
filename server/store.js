'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIELDS = ['name', 'make', 'model', 'year', 'host', 'port', 'protocol', 'vin', 'color', 'notes', 'redline'];

/**
 * Persists vehicle profiles to a JSON file. Each profile describes one car and
 * the adapter used to reach it (host/port), so any number of vehicles can be
 * saved and switched between or monitored at the same time.
 */
class VehicleStore {
  constructor(file) {
    this.file = file;
    this.vehicles = [];
    this.ephemeral = new Set(); // ids that are never written to disk (demo vehicles)
    this._load();
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`Could not read ${this.file}: ${err.message}`);
      this.vehicles = [];
    }
  }

  _save() {
    const persistent = this.vehicles.filter((v) => !this.ephemeral.has(v.id));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ vehicles: persistent }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() {
    return this.vehicles.map((v) => ({ ...v, demo: this.ephemeral.has(v.id) }));
  }

  get(id) {
    return this.vehicles.find((v) => v.id === id) || null;
  }

  findByVin(vin) {
    if (!vin) return null;
    return this.vehicles.find((v) => v.vin && v.vin.toUpperCase() === vin.toUpperCase()) || null;
  }

  create(input, { ephemeral = false } = {}) {
    const vehicle = { id: crypto.randomUUID(), ...validate(input, true), createdAt: new Date().toISOString() };
    this.vehicles.push(vehicle);
    if (ephemeral) this.ephemeral.add(vehicle.id);
    else this._save();
    return vehicle;
  }

  update(id, input) {
    const vehicle = this.get(id);
    if (!vehicle) return null;
    Object.assign(vehicle, validate(input, false), { updatedAt: new Date().toISOString() });
    if (!this.ephemeral.has(id)) this._save();
    return vehicle;
  }

  remove(id) {
    const before = this.vehicles.length;
    this.vehicles = this.vehicles.filter((v) => v.id !== id);
    const removed = this.vehicles.length !== before;
    if (removed && !this.ephemeral.delete(id)) this._save();
    return removed;
  }
}

class ValidationError extends Error {}

function validate(input, requireAll) {
  const out = {};
  for (const key of FIELDS) {
    if (input[key] === undefined) continue;
    let value = input[key];
    if (typeof value === 'string') value = value.trim();
    out[key] = value === '' ? null : value;
  }
  if (requireAll || 'name' in out) {
    if (!out.name || typeof out.name !== 'string') throw new ValidationError('Vehicle name is required');
    out.name = out.name.slice(0, 60);
  }
  if (requireAll || 'host' in out) {
    if (!out.host || !/^[A-Za-z0-9.\-:]+$/.test(out.host)) throw new ValidationError('A valid adapter host/IP is required');
  }
  if (requireAll || 'port' in out) {
    const port = Number(out.port ?? 35000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError('Port must be 1–65535');
    out.port = port;
  }
  if ('protocol' in out || requireAll) {
    const p = String(out.protocol ?? '0').toUpperCase();
    if (!/^[0-9A-C]$/.test(p)) throw new ValidationError('Protocol must be 0–9 or A–C');
    out.protocol = p;
  }
  if (out.year != null) {
    const y = Number(out.year);
    if (!Number.isInteger(y) || y < 1980 || y > 2100) throw new ValidationError('Year looks invalid');
    out.year = y;
  }
  if (out.redline != null) {
    const r = Number(out.redline);
    if (!Number.isInteger(r) || r < 1500 || r > 12000) throw new ValidationError('Redline must be 1,500–12,000 rpm');
    out.redline = r;
  }
  if (out.vin != null) {
    out.vin = String(out.vin).toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(out.vin)) throw new ValidationError('VIN must be 17 characters (no I, O or Q)');
  }
  if (out.color != null && !/^#[0-9a-fA-F]{6}$/.test(out.color)) throw new ValidationError('Color must be #RRGGBB');
  for (const k of ['make', 'model', 'notes']) {
    if (out[k] != null) out[k] = String(out[k]).slice(0, k === 'notes' ? 500 : 40);
  }
  return out;
}

module.exports = { VehicleStore, ValidationError };
