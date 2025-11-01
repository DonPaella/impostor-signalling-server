const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let rooms = {};

app.get("/", (req, res) => {
  res.send("Signaling server is running");
});

wss.on("connection", (ws, req) => {
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      const { type, room, payload } = data;

      if (type === "join" && room) {
        ws.room = room;
        rooms[room] = rooms[room] || [];
        rooms[room].push(ws);

        // tell other peers in the room someone joined
        rooms[room].forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "peer-joined", id: req.socket.remoteAddress }));
          }
        });
      } else if (type === "signal" && room && rooms[room]) {
        // forward signaling messages to other clients in same room
        rooms[room].forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "signal", payload }));
          }
        });
      }
    } catch (err) {
      console.error("Invalid message:", err);
    }
  });

  ws.on("close", () => {
    if (ws.room && rooms[ws.room]) {
      rooms[ws.room] = rooms[ws.room].filter((c) => c !== ws);
      if (rooms[ws.room].length === 0) delete rooms[ws.room];
    }
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});