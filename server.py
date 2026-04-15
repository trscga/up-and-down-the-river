"""Up and Down the River - Game Server (Python + aiohttp + websockets)"""

import asyncio
import json
import os
import random
import string
from pathlib import Path

from aiohttp import web

# ─── Constants ────────────────────────────────────────────────────────────────

SUITS = ['hearts', 'diamonds', 'clubs', 'spades']
RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
RANK_VALUES = {r: i + 2 for i, r in enumerate(RANKS)}

PUBLIC_DIR = Path(__file__).parent / 'public'


def generate_room_code():
    chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    return ''.join(random.choices(chars, k=5))


def create_deck():
    return [{'suit': s, 'rank': r, 'value': RANK_VALUES[r]} for s in SUITS for r in RANKS]


def shuffle_deck():
    deck = create_deck()
    random.shuffle(deck)
    return deck


# ─── Game Room ────────────────────────────────────────────────────────────────

class GameRoom:
    def __init__(self, code, host_id, host_name):
        self.code = code
        self.players = [{'id': host_id, 'name': host_name, 'connected': True}]
        self.state = 'lobby'
        self.scores = {host_id: 0}
        self.dealer_index = 0
        self.round_number = 0
        self.cards_this_round = 0
        self.round_sequence = []
        self.trump_card = None
        self.trump_suit = None
        self.hands = {}
        self.bids = {}
        self.tricks = {}
        self.current_trick = []
        self.turn_index = 0
        self.lead_index = 0
        self.round_scores = []

    def add_player(self, pid, name):
        if len(self.players) >= 6:
            return False
        if self.state != 'lobby':
            return False
        if any(p['id'] == pid for p in self.players):
            return False
        self.players.append({'id': pid, 'name': name, 'connected': True})
        self.scores[pid] = 0
        return True

    def remove_player(self, pid):
        self.players = [p for p in self.players if p['id'] != pid]
        self.scores.pop(pid, None)
        self.hands.pop(pid, None)
        self.bids.pop(pid, None)
        self.tricks.pop(pid, None)

    def build_round_sequence(self):
        # 1..7 normal, 7 no-trump, 7 delayed-trump, 6..1 normal
        seq = []
        for i in range(1, 8):
            seq.append({'cards': i, 'type': 'normal'})
        seq.append({'cards': 7, 'type': 'no-trump'})
        seq.append({'cards': 7, 'type': 'delayed-trump'})
        for i in range(6, 0, -1):
            seq.append({'cards': i, 'type': 'normal'})
        self.round_sequence = seq

    def start_game(self):
        if len(self.players) < 2:
            return False
        self.state = 'bidding'
        for p in self.players:
            self.scores[p['id']] = 0
        self.dealer_index = 0
        self.round_number = 0
        self.round_scores = []
        self.build_round_sequence()
        self._start_round()
        return True

    def _start_round(self):
        round_info = self.round_sequence[self.round_number]
        self.cards_this_round = round_info['cards']
        self.round_type = round_info['type']  # 'normal', 'no-trump', 'delayed-trump'
        self.bids = {}
        self.tricks = {}
        self.current_trick = []
        for p in self.players:
            self.tricks[p['id']] = 0

        deck = shuffle_deck()
        n = len(self.players)
        self.hands = {}
        for i, p in enumerate(self.players):
            hand = deck[:self.cards_this_round]
            deck = deck[self.cards_this_round:]
            hand.sort(key=lambda c: (SUITS.index(c['suit']), c['value']))
            self.hands[p['id']] = hand

        if self.round_type == 'no-trump':
            # No trump this round
            self.trump_card = None
            self.trump_suit = None
        elif self.round_type == 'delayed-trump':
            # Trump exists but is hidden until after bidding
            if deck:
                self.trump_card = deck[0]
                self.trump_suit = self.trump_card['suit']
            else:
                self.trump_card = None
                self.trump_suit = None
            self.trump_revealed = False
        else:
            # Normal: reveal trump immediately
            if deck:
                self.trump_card = deck[0]
                self.trump_suit = self.trump_card['suit']
            else:
                self.trump_card = None
                self.trump_suit = None
            self.trump_revealed = True

        self.turn_index = (self.dealer_index + 1) % n
        self.lead_index = self.turn_index
        self.state = 'bidding'

    def current_player_id(self):
        return self.players[self.turn_index]['id']

    def place_bid(self, player_id, bid):
        if self.state != 'bidding':
            return {'ok': False, 'msg': 'Not in bidding phase'}
        if self.current_player_id() != player_id:
            return {'ok': False, 'msg': 'Not your turn to bid'}
        if bid < 0 or bid > self.cards_this_round:
            return {'ok': False, 'msg': 'Invalid bid'}

        self.bids[player_id] = bid

        n = len(self.players)
        if len(self.bids) == n:
            # Reveal delayed trump now that bidding is complete
            if getattr(self, 'round_type', 'normal') == 'delayed-trump' and not getattr(self, 'trump_revealed', True):
                self.trump_revealed = True
            self.state = 'playing'
            self.turn_index = self.lead_index
        else:
            self.turn_index = (self.turn_index + 1) % n

        return {'ok': True}

    def play_card(self, player_id, card_data):
        if self.state != 'playing':
            return {'ok': False, 'msg': 'Not in playing phase'}
        if self.current_player_id() != player_id:
            return {'ok': False, 'msg': 'Not your turn'}

        hand = self.hands[player_id]
        card_idx = None
        for i, c in enumerate(hand):
            if c['rank'] == card_data['rank'] and c['suit'] == card_data['suit']:
                card_idx = i
                break
        if card_idx is None:
            return {'ok': False, 'msg': 'Card not in your hand'}

        if self.current_trick:
            led_suit = self.current_trick[0]['card']['suit']
            has_suit = any(c['suit'] == led_suit for c in hand)
            if has_suit and card_data['suit'] != led_suit:
                return {'ok': False, 'msg': f'You must follow suit ({led_suit})'}

        card = hand.pop(card_idx)
        self.current_trick.append({'playerId': player_id, 'card': card})

        n = len(self.players)
        if len(self.current_trick) == n:
            winner = self._determine_trick_winner()
            self.tricks[winner] += 1
            completed_trick = list(self.current_trick)
            self.current_trick = []

            all_empty = all(len(h) == 0 for h in self.hands.values())
            if all_empty:
                self._score_round()
                if self.round_number >= len(self.round_sequence) - 1:
                    self.state = 'gameOver'
                else:
                    self.state = 'roundEnd'
                return {'ok': True, 'trickComplete': True, 'trickWinner': winner,
                        'completedTrick': completed_trick, 'roundOver': True}

            winner_idx = next(i for i, p in enumerate(self.players) if p['id'] == winner)
            self.turn_index = winner_idx
            self.lead_index = winner_idx
            return {'ok': True, 'trickComplete': True, 'trickWinner': winner,
                    'completedTrick': completed_trick}
        else:
            self.turn_index = (self.turn_index + 1) % n
            return {'ok': True, 'trickComplete': False}

    def _determine_trick_winner(self):
        led_suit = self.current_trick[0]['card']['suit']
        best = self.current_trick[0]

        for play in self.current_trick[1:]:
            best_is_trump = best['card']['suit'] == self.trump_suit
            curr_is_trump = play['card']['suit'] == self.trump_suit

            if curr_is_trump and not best_is_trump:
                best = play
            elif curr_is_trump and best_is_trump:
                if play['card']['value'] > best['card']['value']:
                    best = play
            elif not curr_is_trump and not best_is_trump:
                if play['card']['suit'] == led_suit and best['card']['suit'] == led_suit:
                    if play['card']['value'] > best['card']['value']:
                        best = play
                elif play['card']['suit'] == led_suit:
                    best = play

        return best['playerId']

    def _score_round(self):
        round_data = {
            'round': self.round_number + 1,
            'cardsThisRound': self.cards_this_round,
            'playerScores': {}
        }
        for p in self.players:
            pid = p['id']
            bid = self.bids.get(pid, 0)
            tricks = self.tricks.get(pid, 0)
            points = (10 + tricks) if bid == tricks else 0
            self.scores[pid] += points
            round_data['playerScores'][pid] = {
                'bid': bid, 'tricks': tricks, 'points': points, 'total': self.scores[pid]
            }
        self.round_scores.append(round_data)

    def next_round(self):
        self.round_number += 1
        self.dealer_index = (self.dealer_index + 1) % len(self.players)
        self._start_round()

    def get_public_state(self, for_player_id):
        player_list = []
        for p in self.players:
            pid = p['id']
            player_list.append({
                'id': pid,
                'name': p['name'],
                'connected': p['connected'],
                'score': self.scores.get(pid, 0),
                'bid': self.bids.get(pid),
                'tricksWon': self.tricks.get(pid, 0),
                'cardCount': len(self.hands.get(pid, []))
            })

        current_turn = None
        if self.state not in ('lobby', 'gameOver', 'roundEnd'):
            current_turn = self.current_player_id()

        return {
            'roomCode': self.code,
            'state': self.state,
            'players': player_list,
            'dealerIndex': self.dealer_index,
            'roundNumber': self.round_number + 1,
            'totalRounds': len(self.round_sequence),
            'cardsThisRound': self.cards_this_round,
            'roundType': getattr(self, 'round_type', 'normal'),
            'trumpCard': self.trump_card if getattr(self, 'trump_revealed', True) else None,
            'trumpSuit': self.trump_suit if getattr(self, 'trump_revealed', True) else None,
            'trumpHidden': getattr(self, 'round_type', 'normal') == 'delayed-trump' and not getattr(self, 'trump_revealed', True),
            'currentTrick': [{'playerId': t['playerId'], 'card': t['card']} for t in self.current_trick],
            'currentTurnId': current_turn,
            'myHand': self.hands.get(for_player_id, []),
            'roundScores': self.round_scores,
            'scores': dict(self.scores)
        }


# ─── Server ──────────────────────────────────────────────────────────────────

rooms = {}          # code -> GameRoom
ws_clients = {}     # ws -> { room_code, player_id, player_name }
player_ws = {}      # player_id -> ws


async def send_json(ws, data):
    try:
        await ws.send_str(json.dumps(data))
    except Exception:
        pass


async def emit_state(room):
    for p in room.players:
        ws = player_ws.get(p['id'])
        if ws and not ws.closed:
            state = room.get_public_state(p['id'])
            await send_json(ws, {'type': 'gameState', 'data': state})


async def emit_trick_complete(room, trick_data):
    for p in room.players:
        ws = player_ws.get(p['id'])
        if ws and not ws.closed:
            await send_json(ws, {'type': 'trickComplete', 'data': trick_data})


async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    # Assign a unique player ID
    player_id = ''.join(random.choices(string.ascii_letters + string.digits, k=16))
    ws_clients[ws] = {'room_code': None, 'player_id': player_id, 'player_name': None}
    player_ws[player_id] = ws

    # Send the player their ID
    await send_json(ws, {'type': 'yourId', 'data': {'id': player_id}})

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue

                action = data.get('action')
                payload = data.get('payload', {})
                req_id = data.get('reqId')

                if action == 'createRoom':
                    await handle_create_room(ws, player_id, payload, req_id)
                elif action == 'joinRoom':
                    await handle_join_room(ws, player_id, payload, req_id)
                elif action == 'startGame':
                    await handle_start_game(ws, player_id, req_id)
                elif action == 'placeBid':
                    await handle_place_bid(ws, player_id, payload, req_id)
                elif action == 'playCard':
                    await handle_play_card(ws, player_id, payload, req_id)
                elif action == 'nextRound':
                    await handle_next_round(ws, player_id, req_id)
                elif action == 'playAgain':
                    await handle_play_again(ws, player_id, req_id)

            elif msg.type in (web.WSMsgType.ERROR, web.WSMsgType.CLOSE):
                break
    finally:
        await handle_disconnect(ws, player_id)

    return ws


async def reply(ws, req_id, data):
    await send_json(ws, {'type': 'reply', 'reqId': req_id, **data})


async def handle_create_room(ws, player_id, payload, req_id):
    name = (payload.get('name') or '').strip()[:20]
    if not name:
        return await reply(ws, req_id, {'ok': False, 'msg': 'Name is required'})

    code = generate_room_code()
    room = GameRoom(code, player_id, name)
    rooms[code] = room
    ws_clients[ws]['room_code'] = code
    ws_clients[ws]['player_name'] = name
    await reply(ws, req_id, {'ok': True, 'roomCode': code})
    await emit_state(room)


async def handle_join_room(ws, player_id, payload, req_id):
    name = (payload.get('name') or '').strip()[:20]
    code = (payload.get('code') or '').strip().upper()
    if not name:
        return await reply(ws, req_id, {'ok': False, 'msg': 'Name is required'})
    if not code:
        return await reply(ws, req_id, {'ok': False, 'msg': 'Room code is required'})

    room = rooms.get(code)
    if not room:
        return await reply(ws, req_id, {'ok': False, 'msg': 'Room not found'})

    if any(p['name'].lower() == name.lower() for p in room.players):
        return await reply(ws, req_id, {'ok': False, 'msg': 'That name is already taken in this room'})

    if not room.add_player(player_id, name):
        return await reply(ws, req_id, {'ok': False, 'msg': 'Cannot join room (full or game already started)'})

    ws_clients[ws]['room_code'] = code
    ws_clients[ws]['player_name'] = name
    await reply(ws, req_id, {'ok': True, 'roomCode': code})
    await emit_state(room)


async def handle_start_game(ws, player_id, req_id):
    room = get_room(ws)
    if not room:
        return await reply(ws, req_id, {'ok': False, 'msg': 'Room not found'})
    if room.players[0]['id'] != player_id:
        return await reply(ws, req_id, {'ok': False, 'msg': 'Only the host can start the game'})
    if not room.start_game():
        return await reply(ws, req_id, {'ok': False, 'msg': 'Need at least 2 players'})
    await reply(ws, req_id, {'ok': True})
    await emit_state(room)


async def handle_place_bid(ws, player_id, payload, req_id):
    room = get_room(ws)
    if not room:
        return await reply(ws, req_id, {'ok': False, 'msg': 'Room not found'})
    bid = payload.get('bid')
    if bid is None:
        return await reply(ws, req_id, {'ok': False, 'msg': 'Bid is required'})
    result = room.place_bid(player_id, int(bid))
    await reply(ws, req_id, result)
    if result['ok']:
        await emit_state(room)


async def handle_play_card(ws, player_id, payload, req_id):
    room = get_room(ws)
    if not room:
        return await reply(ws, req_id, {'ok': False, 'msg': 'Room not found'})
    card = payload.get('card')
    if not card:
        return await reply(ws, req_id, {'ok': False, 'msg': 'Card is required'})
    result = room.play_card(player_id, card)
    await reply(ws, req_id, result)
    if result['ok']:
        if result.get('trickComplete'):
            winner_name = next(
                (p['name'] for p in room.players if p['id'] == result['trickWinner']), '?'
            )
            trick_data = {
                'winner': result['trickWinner'],
                'winnerName': winner_name,
                'trick': result['completedTrick'],
                'roundOver': result.get('roundOver', False)
            }
            await emit_trick_complete(room, trick_data)
            await asyncio.sleep(2.5)
            await emit_state(room)
        else:
            await emit_state(room)


async def handle_next_round(ws, player_id, req_id):
    room = get_room(ws)
    if not room:
        return await reply(ws, req_id, {'ok': False, 'msg': 'Room not found'})
    if room.players[0]['id'] != player_id:
        return await reply(ws, req_id, {'ok': False, 'msg': 'Only the host can advance'})
    room.next_round()
    await reply(ws, req_id, {'ok': True})
    await emit_state(room)


async def handle_play_again(ws, player_id, req_id):
    room = get_room(ws)
    if not room:
        return await reply(ws, req_id, {'ok': False, 'msg': 'Room not found'})
    if room.players[0]['id'] != player_id:
        return await reply(ws, req_id, {'ok': False, 'msg': 'Only the host can restart'})
    room.dealer_index = 0
    room.round_number = 0
    room.round_scores = []
    room.start_game()
    await reply(ws, req_id, {'ok': True})
    await emit_state(room)


async def handle_disconnect(ws, player_id):
    info = ws_clients.pop(ws, None)
    player_ws.pop(player_id, None)
    if info and info['room_code']:
        room = rooms.get(info['room_code'])
        if room:
            player = next((p for p in room.players if p['id'] == player_id), None)
            if player:
                player['connected'] = False
            if all(not p['connected'] for p in room.players):
                # Schedule removal
                code = info['room_code']
                await asyncio.sleep(60)
                r = rooms.get(code)
                if r and all(not p['connected'] for p in r.players):
                    del rooms[code]
            else:
                await emit_state(room)


def get_room(ws):
    info = ws_clients.get(ws)
    if not info or not info['room_code']:
        return None
    return rooms.get(info['room_code'])


# ─── HTTP Routes ─────────────────────────────────────────────────────────────

app = web.Application()
app.router.add_get('/ws', websocket_handler)
app.router.add_static('/', PUBLIC_DIR, show_index=True)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 3000))
    print(f'Up and Down the River running on http://localhost:{port}')
    web.run_app(app, host='0.0.0.0', port=port)
