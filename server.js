const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static("public"));

const games = {};
const playerStats = {};
const playerNames = {};
const pendingRematches = {};

function emptyBoard() {
  return Array(6).fill().map(() => Array(7).fill(""));
}

function generateGameId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function checkWin(row, col, board, player) {
  const dirs = [
    [[0,1],[0,-1]],   // horizontal
    [[1,0],[-1,0]],   // vertical
    [[1,1],[-1,-1]],  // diagonal down-right
    [[1,-1],[-1,1]]   // diagonal down-left
  ];

  for (let dir of dirs) {
    let count = 1;
    for (let [dx, dy] of dir) {
      let r = row + dx, c = col + dy;
      while (r >= 0 && r < 6 && c >= 0 && c < 7 && board[r][c] === player) {
        count++;
        r += dx;
        c += dy;
      }
    }
    if (count >= 4) return true;
  }
  return false;
}

function getWinningCells(row, col, board, player) {
  const dirs = [
    [[0,1],[0,-1]],   // horizontal
    [[1,0],[-1,0]],   // vertical
    [[1,1],[-1,-1]],  // diagonal down-right
    [[1,-1],[-1,1]]   // diagonal down-left
  ];

  for (let dir of dirs) {
    let cells = [[row, col]];
    for (let [dx, dy] of dir) {
      let r = row + dx, c = col + dy;
      while (r >= 0 && r < 6 && c >= 0 && c < 7 && board[r][c] === player) {
        cells.push([r, c]);
        r += dx;
        c += dy;
      }
    }
    if (cells.length >= 4) {
      const winningCells = [];
      const firstCell = cells[0];
      const lastCell = cells[cells.length - 1];
      
      const dx = Math.sign(lastCell[0] - firstCell[0]);
      const dy = Math.sign(lastCell[1] - firstCell[1]);
      
      for (let i = 0; i < 4; i++) {
        winningCells.push([firstCell[0] + (dx * i), firstCell[1] + (dy * i)]);
      }
      return winningCells;
    }
  }
  return [];
}

function isBoardFull(board) {
  return board[0].every(cell => cell !== "");
}

function initializePlayerStats(gameId, redPlayerId, yellowPlayerId, redName, yellowName) {
  if (!playerStats[gameId]) {
    playerStats[gameId] = {
      seriesId: gameId,
      red: { id: redPlayerId, name: redName, wins: 0 },
      yellow: { id: yellowPlayerId, name: yellowName, wins: 0 },
      gamesPlayed: 0
    };
  }
  return playerStats[gameId];
}

function updatePlayerStats(gameId, winner) {
  const stats = playerStats[gameId];
  if (!stats) return;
  
  stats.gamesPlayed++;
  
  if (winner === "red") {
    stats.red.wins++;
  } else if (winner === "yellow") {
    stats.yellow.wins++;
  }
}

io.on("connection", socket => {
  console.log(`New connection: ${socket.id}`);

  socket.on("setPlayerName", (name) => {
    if (name && name.trim().length > 0) {
      playerNames[socket.id] = name.trim().substring(0, 15);
      socket.emit("nameSet", { success: true, name: playerNames[socket.id] });
    } else {
      playerNames[socket.id] = `Player_${socket.id.substring(0, 4)}`;
      socket.emit("nameSet", { success: true, name: playerNames[socket.id] });
    }
  });

  socket.on("createGame", () => {
    const gameId = generateGameId();
    const playerName = playerNames[socket.id] || `Player_${socket.id.substring(0, 4)}`;
    
    games[gameId] = {
      board: emptyBoard(),
      currentPlayer: "red",
      players: { 
        red: socket.id,
        redName: playerName,
        yellow: null,
        yellowName: null
      },
      winner: null,
      winningCells: [],
      status: "waiting",
      createdAt: Date.now(),
      lastMoveAt: null,
      moves: 0,
      originalGameId: gameId,
      gameNumber: 1
    };

    socket.join(gameId);
    
    console.log(`Game created: ${gameId} by ${playerName}`);
    
    socket.emit("gameCreated", { 
      gameId, 
      color: "red",
      playerName: playerName,
      gameNumber: 1
    });

    io.to(gameId).emit("gameUpdate", games[gameId]);
  });

  socket.on("joinGame", (gameId) => {
    const game = games[gameId];
    
    if (!game) {
      socket.emit("errorMsg", "Game not found. Please check the Game ID.");
      return;
    }
    
    if (game.players.yellow) {
      socket.emit("errorMsg", "Game is already full. Please join another game.");
      return;
    }

    const playerName = playerNames[socket.id] || `Player_${socket.id.substring(0, 4)}`;
    game.players.yellow = socket.id;
    game.players.yellowName = playerName;
    game.status = "playing";
    socket.join(gameId);

    initializePlayerStats(
      game.originalGameId, 
      game.players.red, 
      game.players.yellow,
      game.players.redName,
      game.players.yellowName
    );
    
    console.log(`Player ${playerName} joined game ${gameId} as yellow`);
    
    socket.emit("gameJoined", { 
      gameId, 
      color: "yellow",
      playerName: playerName,
      gameNumber: game.gameNumber
    });

    io.to(gameId).emit("playerJoined", {
      players: game.players
    });

    io.to(gameId).emit("gameUpdate", game);
    
    const stats = playerStats[game.originalGameId];
    if (stats) {
      io.to(gameId).emit("statsUpdate", stats);
    }
  });

  socket.on("makeMove", ({ gameId, col, color }) => {
    const game = games[gameId];
    
    if (!game) {
      socket.emit("errorMsg", "Game not found.");
      return;
    }
    
    if (game.winner) {
      socket.emit("errorMsg", "Game has already ended.");
      return;
    }
    
    if (game.currentPlayer !== color) {
      socket.emit("errorMsg", "It's not your turn.");
      return;
    }
    
    if (!game.players.red || !game.players.yellow) {
      socket.emit("errorMsg", "Waiting for opponent to join.");
      return;
    }
    
    if (col < 0 || col > 6) {
      socket.emit("errorMsg", "Invalid column.");
      return;
    }

    let row = -1;
    for (let r = 5; r >= 0; r--) {
      if (!game.board[r][col]) {
        row = r;
        break;
      }
    }

    if (row === -1) {
      socket.emit("errorMsg", "Column is full. Choose another column.");
      return;
    }

    game.board[row][col] = color;
    game.moves++;
    game.lastMoveAt = Date.now();

    if (checkWin(row, col, game.board, color)) {
      game.winner = color;
      game.winningCells = getWinningCells(row, col, game.board, color);
      game.status = "finished";
      
      updatePlayerStats(game.originalGameId, color);
      
    } else if (isBoardFull(game.board)) {
      game.winner = "draw";
      game.status = "finished";
    } else {
      game.currentPlayer = color === "red" ? "yellow" : "red";
    }

    io.to(gameId).emit("moveAnimation", {
      row,
      col,
      color
    });

    setTimeout(() => {
      io.to(gameId).emit("gameUpdate", game);
      
      if (game.winner) {
        const stats = playerStats[game.originalGameId];
        if (stats) {
          io.to(gameId).emit("statsUpdate", stats);
        }
      }
    }, 500);
  });

  socket.on("requestRematch", ({ gameId }) => {
    const game = games[gameId];
    if (!game || !game.players.red || !game.players.yellow) {
      socket.emit("errorMsg", "Cannot request rematch.");
      return;
    }

    const requestingPlayer = socket.id;
    const opponentId = game.players.red === requestingPlayer ? game.players.yellow : game.players.red;
    
    pendingRematches[gameId] = {
      gameId: gameId,
      requester: requestingPlayer,
      opponent: opponentId,
      timestamp: Date.now()
    };

    socket.to(opponentId).emit("rematchRequested", {
      fromPlayer: playerNames[requestingPlayer] || "Opponent",
      gameId: gameId
    });

    socket.emit("rematchRequestSent", {
      toPlayer: playerNames[opponentId] || "Opponent"
    });
  });

  socket.on("acceptRematch", ({ gameId }) => {
    const pendingRematch = pendingRematches[gameId];
    if (!pendingRematch || pendingRematch.opponent !== socket.id) {
      socket.emit("errorMsg", "Invalid rematch acceptance.");
      return;
    }

    const game = games[gameId];
    if (!game) {
      socket.emit("errorMsg", "Game not found.");
      return;
    }

    const originalGameId = game.originalGameId;
    const stats = playerStats[originalGameId];
    
    if (!stats) {
      socket.emit("errorMsg", "Game stats not found.");
      return;
    }

    const newGameId = generateGameId();
    
    games[newGameId] = {
      board: emptyBoard(),
      currentPlayer: "red",
      players: {
        red: game.players.red,
        redName: game.players.redName,
        yellow: game.players.yellow,
        yellowName: game.players.yellowName
      },
      winner: null,
      winningCells: [],
      status: "playing",
      createdAt: Date.now(),
      lastMoveAt: null,
      moves: 0,
      originalGameId: originalGameId,
      gameNumber: stats.gamesPlayed + 1
    };

    [game.players.red, game.players.yellow].forEach(playerId => {
      if (playerId) {
        const playerSocket = io.sockets.sockets.get(playerId);
        if (playerSocket) {
          playerSocket.leave(gameId);
          playerSocket.join(newGameId);
        }
      }
    });

    delete games[gameId];
    delete pendingRematches[gameId];

    console.log(`Rematch accepted: ${gameId} -> ${newGameId} (Game ${stats.gamesPlayed + 1})`);
    
    io.to(newGameId).emit("rematchStarted", {
      newGameId,
      originalGameId,
      gameNumber: stats.gamesPlayed + 1,
      players: games[newGameId].players
    });

    io.to(newGameId).emit("gameUpdate", games[newGameId]);
    
    io.to(newGameId).emit("statsUpdate", stats);
  });

  socket.on("declineRematch", ({ gameId }) => {
    const pendingRematch = pendingRematches[gameId];
    if (pendingRematch) {
      io.to(pendingRematch.requester).emit("rematchDeclined", {
        byPlayer: playerNames[socket.id] || "Opponent"
      });
      delete pendingRematches[gameId];
    }
  });

  socket.on("leaveGame", (gameId) => {
    const game = games[gameId];
    if (game) {
      console.log(`Player ${socket.id} leaving game ${gameId}`);
      
      const opponentLeftMessage = {
        message: "Opponent left the game. Game ended.",
        autoReturn: true,
        opponentName: playerNames[socket.id] || "Opponent"
      };
      
      if (game.players.red === socket.id) {
        game.players.red = null;
        game.status = "abandoned";
        game.winner = "yellow";
        
        // Notify yellow player if exists
        if (game.players.yellow) {
          io.to(game.players.yellow).emit("opponentLeft", opponentLeftMessage);
        }
      } else if (game.players.yellow === socket.id) {
        game.players.yellow = null;
        game.status = "abandoned";
        game.winner = "red";
        
        // Notify red player if exists
        if (game.players.red) {
          io.to(game.players.red).emit("opponentLeft", opponentLeftMessage);
        }
      }
      
      socket.leave(gameId);
      
      // Clean up pending rematch
      if (pendingRematches[gameId]) {
        delete pendingRematches[gameId];
      }
      
      // Remove game after a short delay
      setTimeout(() => {
        if (games[gameId]) {
          delete games[gameId];
          console.log(`Game ${gameId} removed after player left`);
        }
      }, 5000);
    }
  });

  socket.on("disconnect", () => {
    console.log(`Player disconnected: ${socket.id}`);
    
    for (const [gameId, game] of Object.entries(games)) {
      if (game.players.red === socket.id || game.players.yellow === socket.id) {
        console.log(`Player ${socket.id} disconnected from game ${gameId}`);
        
        const opponentLeftMessage = {
          message: "Opponent disconnected. Game ended.",
          autoReturn: true,
          opponentName: playerNames[socket.id] || "Opponent"
        };
        
        if (game.players.red === socket.id) {
          game.players.red = null;
          game.status = "abandoned";
          game.winner = "yellow";
          
          if (game.players.yellow) {
            io.to(game.players.yellow).emit("opponentLeft", opponentLeftMessage);
          }
        } else if (game.players.yellow === socket.id) {
          game.players.yellow = null;
          game.status = "abandoned";
          game.winner = "red";
          
          if (game.players.red) {
            io.to(game.players.red).emit("opponentLeft", opponentLeftMessage);
          }
        }
        
        // Clean up pending rematch
        if (pendingRematches[gameId]) {
          delete pendingRematches[gameId];
        }
        
        // Remove game after delay
        setTimeout(() => {
          if (games[gameId]) {
            delete games[gameId];
            console.log(`Game ${gameId} removed after disconnect`);
          }
        }, 5000);
      }
    }
    
    delete playerNames[socket.id];
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [gameId, rematch] of Object.entries(pendingRematches)) {
    if (now - rematch.timestamp > 60000) {
      delete pendingRematches[gameId];
      console.log(`Removed expired rematch request for game ${gameId}`);
    }
  }
}, 30000);

setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  for (const [gameId, game] of Object.entries(games)) {
    if (now - game.createdAt > oneHour) {
      delete games[gameId];
      console.log(`Removed old game: ${gameId}`);
    }
  }
}, 5 * 60 * 1000);

server.listen(3000, () => {
  console.log("Connect Four Server running at http://localhost:3000");
});