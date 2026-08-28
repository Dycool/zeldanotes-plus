<p align="center">
  <img src="favicon.svg" alt="Zelda Notes Plus Triforce icon" width="128" height="128">
</p>

# Zelda Notes Plus

**A standalone web client for Nintendo Switch Online Zelda Notes with a modern interface and anonymous global map sharing.**

🗺️ **Zelda Notes Web Service** — Sign in with a Nintendo Account and launch the official Zelda Notes experience from a responsive standalone client.

🌍 **Anonymous global location sharing** — Opt in to share your live map position and see other connected players as colored Zelda-style arrows.

🧭 **Native map behavior** — Shared arrows use Zelda Notes’ own player icon and map projection, so they follow pan, zoom, game, and map-layer changes.

🔐 **Secure session flow** — Uses nxapi-znca-api for Coral attestation and routes Nintendo WebView traffic through the dedicated encrypted Worker backend.

📱 **Responsive layout** — Designed for desktop and mobile browsers with an in-app full-screen Zelda Notes WebView.

---

## 🚀 Live WebApp

Open the deployed client at **[https://dycool.github.io/zeldanotes-plus/](https://dycool.github.io/zeldanotes-plus/)**.

1. Select **Sign In** and acknowledge the nxapi disclosure.
2. Complete Nintendo Account sign-in and paste the returned link or token.
3. Launch Zelda Notes and open Navigation.
4. Use **Global Location Sharing** to publish your anonymous position.
5. Use **Show Other Players** to control anonymous arrows on the map.

---

## 🧱 Architecture

```text
Zelda Notes Plus (static web client)
              |
              +--> Zelda Notes Worker Backend (auth, Coral, sessions)
              |
              +--> Zelda Notes Nintendo WebView
                         |
                         +--> Anonymous ShareHub relay
```

The client supports the Nintendo Switch Online authentication and Coral token flow, then opens Zelda Notes through the dedicated Worker. The Worker injects the bridge used for logout, map-position capture, and anonymous location sharing.

---

## 📂 Project Structure

```text
zeldanotes-plus/
├── index.html       # Application shell, sign-in flow, and WebView container
├── css/app.css      # Responsive layout and application styling
├── js/app.js        # Authentication, backend transport, and Zelda launcher
├── sw.js            # Service worker registration and caching
├── favicon.svg      # Application icon
└── README.md
```

---

## 🛠️ Development

This repository is a static web client. Serve the project with any static HTTP server, then open the local page in a browser:

```bash
npx serve . -l 8080
```

The production build points to the deployed Zelda Notes Worker backend. The backend repository contains its own deployment and test instructions.

---

## 🔐 Privacy & Third-Party Services

* Global location sharing is opt-in for publishing and has a separate visibility toggle for receiving anonymous arrows.
* No Nintendo username, nickname, or page path is shared with other players.
* Live coordinates exist only while the relay connection is active; the last captured position may be heartbeated until that connection closes.
* Sign-in uses the third-party [`nxapi-znca-api`](https://github.com/samuelthomas2774/nxapi-znca-api) service for Coral attestation and request encryption. The sign-in screen provides the required disclosure before authentication.

---

## 📄 License & Nintendo Notice

The project’s original source code is available under the [MIT License](LICENSE).

This is an unofficial interoperability project and is not affiliated with, endorsed by, sponsored by, or approved by Nintendo. Nintendo, Nintendo Switch, Nintendo Switch 2, Zelda Notes, and related names, logos, game-service content, and APIs remain the property of their respective owners.
