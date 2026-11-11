# OBD2 Live — WiFi OBD2 dashboard

A live diagnostics dashboard that connects **directly to ELM327-compatible WiFi OBD2 scanners**, reads
your vehicle's sensors in real time and shows them as gauges, tiles, trend charts and trouble codes.
You can save **any number of vehicles** and connect to several at once.

## Features

- **Direct adapter connection.** Talks to the scanner over its raw TCP socket using the ELM327 command set. No phone app or cloud service sits in between.
- **Multi-vehicle.** Every vehicle is a saved profile (name, make/model/year, colour, adapter IP/port, protocol). You can connect to several adapters at the same time, and the *All vehicles* page shows them side by side.
- **Automatic vehicle identification.** On first connect the VIN is read and saved to the profile. If you later plug the same adapter into a different car, the dashboard warns you and points to the matching profile.
- **Live data.** Polls only the PIDs your car says it supports. Fast values (RPM, speed, throttle, load, MAF, MAP) are read every cycle. Temperatures, fuel level and fuel trims are read less often. A typical CAN car gives about 25–30 readings per second.
  - Gauges: RPM (with a red zone) and speed
  - Tiles: coolant, oil and intake temps; throttle; load; battery and ECU voltage; fuel level; MAF; MAP; timing; short- and long-term fuel trims; fuel rate; run time; distances. Six key readings show by default and the rest sit behind *Show all readings*, grouped into Engine, Fuel & air, Electrical and Trip. Out-of-range values get a warning or critical flag and move to the front.
  - Alert strip: the check-engine light, trouble codes and any out-of-range reading are listed directly under the vehicle header.
  - Stale data: when readings stop, the header shows how old the last reading is, and values are blanked after a minute.
  - Trend charts: pick any metrics and view the last 1, 5 or 10 minutes, with a hover crosshair
- **Diagnostics.** Shows the check-engine light, stored, pending and permanent DTCs with descriptions, and lets you clear codes after a confirmation.
- **Adapter console.** Shows the live TX/RX traffic and lets you send raw commands (`ATRV`, `010C`, …), which helps with troubleshooting.
- **Other options:** CSV export of recent data, imperial (default) or metric units, dark/light theme, and a responsive layout for a tablet or phone mounted in the car.
- **Built-in simulator.** Emulates WiFi adapters on running cars, so you can try everything without a vehicle.

## Quick start

Requires Node.js 18+.

```bash
npm install
npm run demo        # dashboard + two simulated cars, no hardware needed
```

Open http://localhost:3000 and click **Connect** on the demo vehicles.

### With your real scanner

1. Plug the scanner into the car's OBD2 port (under the dashboard, driver's side) and turn the ignition **on**. The engine can be running or off.
2. Join your laptop or tablet to the scanner's WiFi network. It is usually named `WiFi_OBDII`, `OBDII`, `V-LINK` or similar.
3. Start the dashboard:
   ```bash
   npm start
   ```
4. Open http://localhost:3000, click **Add vehicle**, and enter the adapter address. Most WiFi ELM327 dongles use **`192.168.0.10` port `35000`**. Some use `192.168.0.123:35000` or `192.168.1.10:23`; check the adapter's manual.
5. Click **Connect**.

To view the dashboard from another device on the same network (for example a phone mounted on the dash while the laptop runs the server), start it with `HOST=0.0.0.0 npm start` and browse to `http://<laptop-ip>:3000`.

### Using several vehicles

- **One adapter per car:** add a profile for each car. When a car's adapter is reachable, connect to it. Profiles remember each car's adapter address, protocol and VIN.
- **One adapter moved between cars:** create a profile per car with the same IP/port. The VIN check tells you if you connect to the wrong profile.
- **Several cars at once:** each WiFi dongle normally creates its own network, so a computer can usually reach only one at a time. To monitor several simultaneously, reach them over different interfaces (for example several WiFi adapters, or dongles in station/client mode on a shared network) and give each profile its own IP. The server keeps an independent connection, polling loop and reconnect logic for each vehicle.

## Architecture

```
 Browser (public/)  ⇄  WebSocket + REST  ⇄  Node server (server/)  ⇄  TCP  ⇄  WiFi ELM327  ⇄  Car ECU
```

Browsers cannot open raw TCP sockets, so a small Node server bridges the adapter to the UI.

| File | Purpose |
|---|---|
| `server/elm327.js` | TCP transport: command queue, `>` prompt framing, timeouts and recovery |
| `server/obd.js` | Pure protocol logic: PID table and decoders, DTC/VIN parsing (CAN multi-frame and legacy), error detection |
| `server/session.js` | One live vehicle connection: init sequence, supported-PID discovery, tiered polling, DTC read/clear, auto-reconnect |
| `server/store.js` | Vehicle profiles persisted to `data/vehicles.json` |
| `server/index.js` | HTTP server, REST API, WebSocket broadcast, `--demo` mode |
| `server/simulator.js` | ELM327 WiFi adapter emulator with a drive-cycle car model |
| `public/` | Dashboard UI (vanilla JS modules, SVG gauges, canvas charts; no build step) |

### REST API

| Method | Path | |
|---|---|---|
| GET | `/api/vehicles` | List profiles with live status |
| POST | `/api/vehicles` | Create `{name, host, port, protocol?, make?, model?, year?, vin?, color?, notes?}` |
| PUT / DELETE | `/api/vehicles/:id` | Update / delete |
| POST | `/api/vehicles/:id/connect` · `/disconnect` | Start / stop the live session |
| GET | `/api/vehicles/:id/snapshot` | Latest values, history, DTCs, adapter info |
| POST | `/api/vehicles/:id/dtcs/read` · `/dtcs/clear` | Read / clear trouble codes |
| POST | `/api/vehicles/:id/command` | Raw adapter command `{command}` |
| GET | `/api/vehicles/:id/log.csv` | Export recent samples (last 10 min) |

The WebSocket at `/ws` pushes `hello`, `vehicles`, `status`, `data`, `dtcs` and `traffic` messages.

## Simulator

```bash
npm run simulator                       # one adapter on port 35000
node server/simulator.js --count 3      # three different cars on 35000–35002
```

Add a vehicle pointing at `127.0.0.1` and the simulator's port. The simulated cars use different protocols (CAN 11-bit, CAN 29-bit, ISO 9141), have different supported PIDs and stored codes, and follow a repeating idle → accelerate → cruise → brake cycle.

## Tests

```bash
npm test
```

The tests cover the protocol decoders (PIDs, bitmaps, DTCs on CAN and legacy buses, VIN formats, error replies). An end-to-end test runs two simulated adapters through the real server and checks REST, WebSocket streaming, VIN learning, raw commands, code clearing and CSV export.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `connect ETIMEDOUT` / `EHOSTUNREACH` | You're not on the adapter's WiFi, or the IP is wrong |
| `ECONNREFUSED` | Right IP, wrong port (try 35000 or 23) |
| *"vehicle ECU not responding"* | Turn the ignition on. If it persists, choose the protocol explicitly in **Edit** instead of Automatic |
| Some tiles never appear | The car doesn't support that PID. Unsupported PIDs are dropped from polling automatically |
| Clearing codes fails | Many cars only accept a clear with the engine **off** and ignition **on** |

Cheap clone adapters sometimes report "v2.1" but implement only part of the command set. The dashboard uses only widely supported commands (`ATZ ATE0 ATL0 ATS0 ATH0 ATAT1 ATSP ATDPN ATRV`).
