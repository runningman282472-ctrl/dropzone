const WebSocket = require("ws");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = process.env.PORT || 8080;
const httpServer = http.createServer((request, response) => {
    if (request.url === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
    }
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not found");
});
const server = new WebSocket.Server({ server: httpServer });
const parties = new Map();
const clients = new Map();
const matches = new Map();
const accounts = new Map();
const accountFile = path.join(process.env.DATA_DIR || __dirname, "accounts.json");
try { JSON.parse(fs.readFileSync(accountFile, "utf8")).forEach(account => accounts.set(account.id, account)); } catch {}
const MAX_PLAYERS = 30;
const MAX_AI = 8;
function seededRandom(seed) { let value = seed >>> 0; return () => { value = (value * 1664525 + 1013904223) >>> 0; return value / 4294967296; }; }
function generateHouses() {
    const random = seededRandom(271828);
    const buildings = [];
    for (let i = 0; i < 18; i += 1) {
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const w = 140 + Math.floor(random() * 75);
            const h = 105 + Math.floor(random() * 60);
            const house = { x: 100 + random() * (4200 - w - 200), y: 100 + random() * (2800 - h - 200), w, h };
            if (!buildings.some(other => house.x < other.x + other.w + 90 && house.x + w + 90 > other.x && house.y < other.y + other.h + 90 && house.y + h + 90 > other.y)) {
                buildings.push(house);
                break;
            }
        }
    }
    return buildings;
}
const houses = generateHouses();
function generateProps(buildings) {
    const random = seededRandom(771903);
    const props = [];
    for (let i = 0; i < 110; i += 1) {
        const kind = ["tree", "bush", "rock", "crate"][i % 4];
        const radius = kind === "tree" ? 23 : kind === "bush" ? 19 : kind === "rock" ? 17 : 15;
        let item;
        for (let attempt = 0; attempt < 80; attempt += 1) {
            item = { kind, x: 80 + random() * (4200 - 160), y: 80 + random() * (2800 - 160), r: radius };
            const nearBuilding = buildings.some(building => item.x > building.x - 30 && item.x < building.x + building.w + 30 && item.y > building.y - 30 && item.y < building.y + building.h + 30);
            const nearProp = props.some(prop => Math.hypot(item.x - prop.x, item.y - prop.y) < radius + prop.r + 16);
            if (!nearBuilding && !nearProp) break;
        }
        props.push(item);
    }
    return props;
}
const props = generateProps(houses);

function send(socket, payload) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function clientById(id) {
    return [...clients.values()].find((client) => client.id === id);
}

function notifyFriends(client) {
    for (const friendId of client.friends || []) {
        const friend = clientById(friendId);
        if (friend) send(friend.socket, { type: "friend_presence", id: client.id, name: client.name, online: true });
    }
}

function accountSnapshot(client) {
    return {
        type: "account_state",
        id: client.id,
        name: client.name,
        friends: client.friends || [],
        friendRequests: client.friendRequests || [],
        friendRequests: client.friendRequests || [],
        stats: client.stats || { matches: 0, kills: 0, wins: 0 }
    };
}

function persistAccounts() {
    try {
        fs.mkdirSync(path.dirname(accountFile), { recursive: true });
        fs.writeFileSync(accountFile, JSON.stringify([...accounts.values()], null, 2));
    } catch (error) {
        console.error("Could not persist accounts:", error.message);
    }
}

function makeCode() {
    let code;
    do code = String(Math.floor(100000 + Math.random() * 900000));
    while (parties.has(code));
    return code;
}

function partyState(code) {
    const party = parties.get(code);
    if (!party) return;
    const members = [...party.members].map((id) => {
        const member = [...clients.values()].find((client) => client.id === id);
        return { id, name: member?.name || "OPERATOR" };
    });
    members.forEach((member) => send(clientById(member.id)?.socket, {
        type: "party_state", code, host: party.host, clientId: member.id,
        rounds: party.rounds || 1,
        members: members.map((entry) => ({ ...entry, team: party.teams?.get(entry.id) ?? 0, online: Boolean(clientById(entry.id)) }))
    }));
}

function removeFromParty(socket) {
    const client = clients.get(socket);
    if (!client?.party) return;
    const code = client.party;
    const party = parties.get(code);
    client.party = null;
    if (!party) return;
    party.members.delete(client.id);
    party.teams?.delete(client.id);
    if (party.host === client.id) {
        party.host = party.members.values().next().value;
        if (!party.host) parties.delete(code);
    }
    if (parties.has(code)) partyState(code);
    send(socket, { type: "party_left" });
}

function joinParty(socket, code) {
    const client = clients.get(socket);
    const party = parties.get(code);
    if (!party) return send(socket, { type: "party_error", message: "Party not found." });
    if (party.members.size >= 30) return send(socket, { type: "party_error", message: "Party is full." });
    removeFromParty(socket);
    party.members.add(client.id);
    client.party = code;
    party.teams ||= new Map();
    if (!party.teams.has(client.id)) party.teams.set(client.id, 0);
    partyState(code);
}

function groupFor(client) {
    if (!client.party) return [client];
    const party = parties.get(client.party);
    return party ? [...party.members].map((id) => [...clients.values()].find((member) => member.id === id)).filter(Boolean) : [client];
}

function spawnPoint(index, total) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const angle = (Math.PI * 2 * (index + attempt * 0.37)) / Math.max(1, total);
        const x = 2100 + Math.cos(angle) * (1350 + attempt * 8);
        const y = 1400 + Math.sin(angle) * (950 + attempt * 6);
        const blockedBuilding = houses.some((house) => x > house.x - 34 && x < house.x + house.w + 34 && y > house.y - 34 && y < house.y + house.h + 34);
        const blockedProp = props.some(prop => Math.hypot(x - prop.x, y - prop.y) < prop.r + 34 || (prop.kind === "crate" && Math.abs(x - prop.x) < 44 && Math.abs(y - prop.y) < 44));
        if (!blockedBuilding && !blockedProp && x > 50 && x < 4150 && y > 50 && y < 2750) return { x, y };
    }
    return { x: 2100, y: 1400 };
}

function startMatch(selected, partyOnly = false) {
    const matchId = Math.random().toString(36).slice(2, 10);
    const party = partyOnly && selected[0].party ? parties.get(selected[0].party) : null;
    const players = selected.map((client, index) => {
        const memberParty = client.party && parties.get(client.party);
        const memberTeam = memberParty ? `${client.party}:${memberParty.teams?.get(client.id) ?? 0}` : client.id;
        return { id: client.id, name: client.name, team: memberTeam, ...spawnPoint(index, selected.length) };
    });
    const aiCount = partyOnly ? 0 : Math.min(MAX_AI, MAX_PLAYERS - selected.length);
    const ai = Array.from({ length: aiCount }, (_, index) => ({ id: `ai-${index}`, name: `AI // ${String(index + 1).padStart(2, "0")}`, ...spawnPoint(selected.length + index, selected.length + aiCount) }));
    const payload = { type: "match_start", matchId, mode: partyOnly ? "party" : "public", hostId: selected[0].id, rounds: party?.rounds || 1, players, aiCount, ai };
    matches.set(matchId, { hostId: selected[0].id, members: new Set(selected.map((client) => client.id)), ai, claimedLoot: new Set(), rounds: party?.rounds || 1, round: 1, scores: new Map(), players: new Map(players.map(player => [player.id, { ...player, hp: 100, shield: 0, weapon: "pistol", ammo: 24 }])) });
    selected.forEach((client) => {
        client.queueing = false;
        client.match = matchId;
        if (accounts.has(client.id)) accounts.get(client.id).stats.matches += 1;
        send(client.socket, payload);
    });
    persistAccounts();
}

function tryStartMatch() {
    const queued = [...clients.values()].filter((client) => client.queueing && !client.match);
    const selected = [];
    const seen = new Set();
    for (const client of queued) {
        if (seen.has(client.id)) continue;
        const group = groupFor(client);
        if (selected.length + group.length > MAX_PLAYERS) continue;
        group.forEach((member) => { seen.add(member.id); selected.push(member); });
    }
    if (!selected.length) return;
    startMatch(selected);
}

function broadcastMatch(client, payload) {
    if (!client.match || !matches.has(client.match)) return;
    matches.get(client.match).members.forEach((id) => {
        const target = [...clients.values()].find((member) => member.id === id);
        if (target && target.id !== client.id) send(target.socket, payload);
    });
}

function broadcastParty(client, payload) {
    if (!client.party || !parties.has(client.party)) return;
    parties.get(client.party).members.forEach((id) => {
        const target = [...clients.values()].find((member) => member.id === id);
        if (target) send(target.socket, payload);
    });
}

function finishRound(matchId, match) {
    const aliveTeams = new Set([...match.players.values()].filter(player => player.hp > 0).map(player => player.team));
    if (aliveTeams.size > 1) return;
    const winner = aliveTeams.values().next().value;
    if (winner !== undefined) match.scores.set(winner, (match.scores.get(winner) || 0) + 1);
    if (match.round < match.rounds) {
        match.round += 1;
        let index = 0;
        for (const player of match.players.values()) Object.assign(player, spawnPoint(index++, match.players.size), { hp: 100, shield: 0 });
        match.members.forEach(id => { const member = clientById(id); if (member) send(member.socket, { type: "match_round_start", round: match.round, rounds: match.rounds, players: [...match.players.values()], scores: Object.fromEntries(match.scores) }); });
        return;
    }
    match.members.forEach(id => { const member = clientById(id); if (member) send(member.socket, { type: "match_complete", winner, scores: Object.fromEntries(match.scores) }); });
    if (winner !== undefined) for (const player of match.players.values()) if (player.team === winner) { const account = accounts.get(player.id); if (account) account.stats.wins = (account.stats.wins || 0) + 1; }
    persistAccounts();
}

server.on("connection", (socket) => {
    const id = Math.random().toString(36).slice(2, 10);
    clients.set(socket, { id, socket, name: "ANONYMOUS", party: null, queueing: false, match: null });
    send(socket, { type: "welcome", id, message: "Connected to multiplayer!" });
    socket.on("message", (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { return send(socket, { type: "party_error", message: "Invalid message." }); }
        const client = clients.get(socket);
        if (message.type === "hello") {
            const requestedId = String(message.accountId || "");
            if (/^[a-zA-Z0-9_-]{16,64}$/.test(requestedId)) {
                const previous = clientById(requestedId);
                if (previous && previous !== client) previous.socket.close(4001, "Account connected elsewhere");
                client.id = requestedId;
            }
            const saved = accounts.get(client.id) || { id: client.id, name: "ANONYMOUS", friends: [], friendRequests: [], stats: { matches: 0, kills: 0, wins: 0 } };
            client.name = String(message.name || saved.name || "ANONYMOUS").slice(0, 14).toUpperCase();
            client.friends = saved.friends || [];
            client.friendRequests = saved.friendRequests || [];
            client.stats = saved.stats;
            accounts.set(client.id, { ...saved, id: client.id, name: client.name, friends: client.friends, friendRequests: client.friendRequests, stats: client.stats });
            persistAccounts();
            send(socket, accountSnapshot(client));
            for (const friendId of client.friends) {
                const friend = clientById(friendId);
                send(socket, { type: "friend_presence", id: friendId, name: friend?.name || accounts.get(friendId)?.name || "UNKNOWN", online: Boolean(friend) });
            }
            notifyFriends(client);
            if (client.party) partyState(client.party);
        }
        if (message.type === "party_create") {
            removeFromParty(socket);
            const code = makeCode();
            parties.set(code, { host: client.id, members: new Set([client.id]), teams: new Map([[client.id, 0]]), rounds: 1 });
            client.party = code;
            partyState(code);
        }
        if (message.type === "party_join") joinParty(socket, String(message.code || ""));
        if (message.type === "party_leave") {
            removeFromParty(socket);
        }
        if (message.type === "friend_add") {
            const friendId = String(message.id || "");
            if (!accounts.has(friendId) || friendId === client.id) {
                send(socket, { type: "friend_error", message: "Player ID not found." });
            } else if ((client.friends || []).includes(friendId)) {
                send(socket, { type: "friend_error", message: "Already friends." });
            } else {
                const targetAccount = accounts.get(friendId);
                targetAccount.friendRequests ||= [];
                if (!targetAccount.friendRequests.some(request => request.id === client.id)) targetAccount.friendRequests.push({ id: client.id, name: client.name });
                client.outgoingRequests ||= [];
                if (!client.outgoingRequests.includes(friendId)) client.outgoingRequests.push(friendId);
                accounts.set(client.id, { ...accounts.get(client.id), id: client.id, name: client.name, friends: client.friends, outgoingRequests: client.outgoingRequests, stats: client.stats });
                persistAccounts();
                const friend = clientById(friendId);
                if (friend) { friend.friendRequests = targetAccount.friendRequests; send(friend.socket, { type: "friend_request", request: { id: client.id, name: client.name } }); }
                send(socket, { type: "friend_request_sent", id: friendId, name: targetAccount.name });
            }
        }
        if (message.type === "friend_accept" || message.type === "friend_decline") {
            const friendId = String(message.id || "");
            const account = accounts.get(client.id);
            const requests = account?.friendRequests || [];
            const request = requests.find(entry => entry.id === friendId);
            if (!request) return send(socket, { type: "friend_error", message: "Friend request not found." });
            account.friendRequests = requests.filter(entry => entry.id !== friendId);
            client.friendRequests = account.friendRequests;
            const requesterAccount = accounts.get(friendId);
            if (requesterAccount) requesterAccount.outgoingRequests = (requesterAccount.outgoingRequests || []).filter(id => id !== client.id);
            if (message.type === "friend_accept") {
                client.friends = [...new Set([...(client.friends || []), friendId])];
                account.friends = client.friends;
                if (requesterAccount) requesterAccount.friends = [...new Set([...(requesterAccount.friends || []), client.id])];
                const requester = clientById(friendId);
                if (requester) { requester.friends = requesterAccount.friends; send(requester.socket, { type: "friend_added", friend: { id: client.id, name: client.name, online: true } }); }
                send(socket, { type: "friend_added", friend: { id: friendId, name: request.name, online: Boolean(requester) } });
                if (requester) send(requester.socket, { type: "friend_presence", id: client.id, name: client.name, online: true });
                notifyFriends(client);
            } else {
                send(socket, { type: "friend_request_declined", id: friendId });
            }
            persistAccounts();
            const requester = clientById(friendId);
            if (requester) send(requester.socket, { type: message.type === "friend_accept" ? "friend_request_accepted" : "friend_request_declined", id: client.id, name: client.name });
        }
        if (message.type === "friend_remove") {
            const friendId = String(message.id || "");
            client.friends = (client.friends || []).filter((id) => id !== friendId);
            accounts.set(client.id, { ...accounts.get(client.id), id: client.id, name: client.name, friends: client.friends, stats: client.stats });
            const friendAccount = accounts.get(friendId);
            if (friendAccount) friendAccount.friends = (friendAccount.friends || []).filter((id) => id !== client.id);
            const friend = clientById(friendId);
            if (friend) friend.friends = (friend.friends || []).filter((id) => id !== client.id);
            persistAccounts();
            send(socket, { type: "friend_removed", id: friendId });
            if (friend) send(friend.socket, { type: "friend_removed", id: client.id });
        }
        if (message.type === "party_invite") {
            const friendId = String(message.id || "");
            const friend = clientById(friendId);
            if (!client.party || !(client.friends || []).includes(friendId)) send(socket, { type: "party_error", message: "Add that player as a friend first." });
            else if (!friend) send(socket, { type: "party_error", message: "That friend is offline." });
            else send(friend.socket, { type: "party_invite", code: client.party, from: client.name });
        }
        if (message.type === "party_kick") {
            const party = client.party && parties.get(client.party);
            const targetId = String(message.id || "");
            const target = clientById(targetId);
            if (!party || party.host !== client.id) send(socket, { type: "party_error", message: "Only the party host can kick members." });
            else if (!party.members.has(targetId) || targetId === client.id) send(socket, { type: "party_error", message: "Invalid party member." });
            else if (target) { removeFromParty(target.socket); send(target.socket, { type: "party_kicked" }); }
        }
        if (message.type === "party_settings") {
            const party = client.party && parties.get(client.party);
            const rounds = Number(message.rounds);
            if (!party || party.host !== client.id) send(socket, { type: "party_error", message: "Only the party host can change settings." });
            else if (![1, 3, 5].includes(rounds)) send(socket, { type: "party_error", message: "Choose 1, 3, or 5 rounds." });
            else {
                party.rounds = rounds;
                if (message.teams && typeof message.teams === "object") {
                    for (const id of party.members) party.teams.set(id, Number(message.teams[id]) === 1 ? 1 : 0);
                }
                partyState(client.party);
            }
        }
        if (message.type === "match_find") {
            const group = groupFor(client);
            const partyOnly = message.mode === "party";
            if (client.party && parties.get(client.party)?.host !== client.id) {
                send(socket, { type: "match_error", message: "Only the party leader can find a match." });
            } else if (group.length > MAX_PLAYERS) {
                send(socket, { type: "match_error", message: "Your party is over the 30-player match cap." });
            } else if (partyOnly && !client.party) {
                send(socket, { type: "match_error", message: "Create or join a party before hosting a party-only match." });
            } else if (partyOnly) {
                startMatch(group, true);
            } else {
                group.forEach((member) => { member.queueing = true; });
                send(socket, { type: "match_queue", players: group.length });
                tryStartMatch();
            }
        }
        if (message.type === "match_leave" && client.match) {
            const match = matches.get(client.match);
            if (match) { match.members.delete(client.id); match.players.delete(client.id); }
            client.match = null;
            send(socket, { type: "match_left" });
        }
        if (message.type === "match_update") {
            const match = matches.get(client.match);
            const playerState = match?.players.get(client.id);
            if (playerState) {
                playerState.x = Number(message.x) || playerState.x;
                playerState.y = Number(message.y) || playerState.y;
                playerState.hp = Math.max(0, Math.min(100, Number(message.hp) || 0));
                playerState.shield = Math.max(0, Math.min(100, Number(message.shield) || 0));
                playerState.angle = Number(message.angle) || 0;
                playerState.weapon = ["pistol", "rifle", "shotgun"].includes(message.weapon) ? message.weapon : playerState.weapon;
                playerState.ammo = Math.max(0, Math.min(999, Number(message.ammo) || 0));
            }
            broadcastMatch(client, {
                type: "match_update",
                player: playerState && { ...playerState, name: client.name }
            });
        }
        if (message.type === "match_damage") {
            const match = matches.get(client.match);
            const attacker = match?.players.get(client.id);
            const targetId = String(message.targetId || "");
            const target = match?.players.get(targetId);
            const damage = Math.max(0, Math.min(100, Number(message.damage) || 0));
            if (!attacker || !target || target.hp <= 0 || attacker.team === target.team || damage <= 0) return;
            const shieldDamage = Math.min(target.shield || 0, damage);
            target.shield -= shieldDamage;
            target.hp = Math.max(0, target.hp - (damage - shieldDamage));
            const update = { type: "match_health", id: targetId, hp: target.hp, shield: target.shield, by: client.id, damage };
            match.members.forEach((id) => { const receiver = clientById(id); if (receiver) send(receiver.socket, update); });
            if (target.hp === 0) {
                const account = accounts.get(client.id);
                if (account) account.stats.kills = (account.stats.kills || 0) + 1;
                persistAccounts();
                const targetClient = clientById(targetId);
                if (targetClient) send(targetClient.socket, { type: "match_eliminated", by: client.name });
                match.members.forEach((id) => { const receiver = clientById(id); if (receiver) send(receiver.socket, { type: "kill_log", killer: client.name, victim: target.name }); });
                finishRound(client.match, match);
            }
        }
        if (message.type === "match_shot") {
            broadcastMatch(client, {
                type: "match_shot",
                shot: {
                    id: client.id,
                    team: matches.get(client.match)?.players.get(client.id)?.team,
                    x: Number(message.x) || 0,
                    y: Number(message.y) || 0,
                    vx: Number(message.vx) || 0,
                    vy: Number(message.vy) || 0,
                    damage: Number(message.damage) || 0,
                    color: String(message.color || "#f5ce61").slice(0, 12)
                }
            });
        }
        if (message.type === "match_ai_health") {
            broadcastMatch(client, {
                type: "match_ai_health",
                index: Number(message.index),
                hp: Math.max(0, Math.min(100, Number(message.hp) || 0))
            });
        }
        if (message.type === "match_ai_update") {
            const match = matches.get(client.match);
            if (!match || match.hostId !== client.id || !Array.isArray(message.ai)) return;
            match.ai = message.ai.slice(0, MAX_AI).map((ai, index) => ({ ...ai, id: `ai-${index}`, hp: Math.max(0, Math.min(100, Number(ai.hp) || 0)) }));
            broadcastMatch(client, { type: "match_ai_update", ai: match.ai });
        }
        if (message.type === "match_ai_damage") {
            const match = matches.get(client.match);
            if (!match || match.hostId !== client.id) return;
            const targetId = String(message.targetId || "");
            const target = match.players.get(targetId);
            if (!target || target.hp <= 0) return;
            const damage = Math.max(0, Math.min(100, Number(message.damage) || 0));
            const shieldDamage = Math.min(target.shield || 0, damage);
            target.shield -= shieldDamage;
            target.hp = Math.max(0, target.hp - damage + shieldDamage);
            match.members.forEach(id => { const receiver=clientById(id); if(receiver)send(receiver.socket,{type:"match_health",id:targetId,hp:target.hp,shield:target.shield,by:String(message.aiName||"AI"),damage}); });
            if (target.hp === 0) {
                const targetClient=clientById(targetId);
                if (targetClient) send(targetClient.socket,{type:"match_eliminated",by:String(message.aiName||"AI")});
                match.members.forEach(id => { const receiver=clientById(id); if(receiver)send(receiver.socket,{type:"kill_log",killer:String(message.aiName||"AI"),victim:target.name}); });
                finishRound(client.match,match);
            }
        }
        if (message.type === "match_loot_take") {
            const match = matches.get(client.match);
            const itemId = String(message.id || "");
            const player = match?.players.get(client.id);
            if (!match || !player || !itemId || match.claimedLoot.has(itemId) || Math.hypot(player.x - Number(message.x), player.y - Number(message.y)) > 80) return;
            match.claimedLoot.add(itemId);
            match.members.forEach(id => { const receiver=clientById(id); if(receiver)send(receiver.socket,{type:"match_loot_taken",id:itemId,by:client.id}); });
        }
        if (message.type === "match_ai_shot" || message.type === "match_loot_state") {
            const match = matches.get(client.match);
            if (match?.hostId === client.id) broadcastMatch(client, {
                type: message.type,
                shot: message.type === "match_ai_shot" ? message.shot : undefined,
                loot: message.type === "match_loot_state" && Array.isArray(message.loot) ? message.loot.slice(0, 300) : undefined
            });
        }
        if (message.type === "party_chat") {
            const text = String(message.text || "").trim().slice(0, 160);
            if (text) broadcastParty(client, { type: "party_chat", from: client.name, text });
        }
    });
    socket.on("close", () => {
        const client = clients.get(socket);
        if (client?.match && matches.has(client.match)) {
            matches.get(client.match).members.delete(client.id);
            matches.get(client.match).players.delete(client.id);
            finishRound(client.match, matches.get(client.match));
        }
        if (client) {
            const hasReplacement = [...clients.values()].some(member => member.id === client.id && member.socket !== socket);
            if (!hasReplacement) for (const friendId of client.friends || []) {
                const friend = clientById(friendId);
                if (friend && friend.socket !== socket) send(friend.socket, { type: "friend_presence", id: client.id, name: client.name, online: false });
            }
        }
        removeFromParty(socket);
        clients.delete(socket);
    });
});

httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Dropzone WebSocket server listening on port ${PORT}`);
});
