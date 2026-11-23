# WhatsApp → Grandlab CRM bridge

Puts WhatsApp messages into the Grandlab database so **gl-crm.html** shows live
conversations instead of October's history.

It only **reads** from WhatsApp. It never sends, never replies, never broadcasts.

---

## Before you start

- Runs on the **shop PC**. It must be on for messages to be recorded.
- Needs **Node 18 or newer**. Check with `node -v`.
- **Do not run this and the old MIA Baileys bridge on the same number.** They
  fight over the WhatsApp session and both get kicked out. Stop the old bridge first.

---

## Steps, in order

**1. Install wacli** — https://wacli.sh — take the Windows build and put
`wacli.exe` somewhere easy, e.g. `C:\Tools\wacli.exe`.

**2. Pair it with WhatsApp** (this is the QR scan)

```
wacli auth
```

A QR code appears in the window. On the shop phone: WhatsApp → Settings →
**Linked devices** → **Link a device** → scan it. It then syncs your history,
which takes a few minutes the first time.

⚠️ This links the **shop's main number**. Same as the old bridge, so no new risk —
but it does mean one tool at a time.

**3. Pull this folder onto the PC**

```
cd C:\Users\User\Desktop\Server\Grandlab-app
git pull
cd tools\gl-wa-bridge
```

**4. Make your settings file**

```
copy .env.example .env
notepad .env
```

Fill in `GL_EMAIL` and `GL_PASSWORD` — the reception login you use for the Hub.
Set `WACLI` to the full path if it isn't on PATH. Save.

> `.env` stays on that PC. Don't commit it, don't paste it into chat.

**5. Check wacli's output matches what the bridge expects**

```
node gl-wa-bridge.mjs probe
```

It prints a couple of real messages and how the bridge reads them.
**Send that output to Claude.** wacli doesn't publish its exact field names, so
this is how the mapping gets confirmed rather than guessed. If the "How this
bridge reads them" part shows nulls, that's what needs fixing — one small edit.

**6. Import the history once**

```
node gl-wa-bridge.mjs backfill
```

Then open the CRM board. The "Not live" banner should be gone and your real
chats should be there.

**7. Leave it running**

```
node gl-wa-bridge.mjs run
```

Checks every 30 seconds. Leave the window open. Ctrl+C stops it.

---

## Is it safe?

| | |
|---|---|
| Sends WhatsApp messages | **No.** It has no send command at all |
| Changes your WhatsApp | **No.** Read-only against wacli's local copy |
| Deletes anything | **No.** Inserts and forward-only updates |
| Overwrites stage / status / notes | **No.** Those columns are never written |
| Overwrites a name reception typed | **No.** Only fills blanks |
| Safe to run twice | **Yes.** Messages are keyed on the WhatsApp message id |

The worst it can do is add rows to `gl_wa_chat` and `gl_wa_msg`.

---

## If something goes wrong

**"Could not run wacli"** — set `WACLI` in `.env` to the full path, e.g.
`WACLI=C:\Tools\wacli.exe`

**"Could not sign in to Grandlab"** — wrong `GL_EMAIL` / `GL_PASSWORD`. Same
login as the Hub apps.

**"wacli did not return JSON"** — run `probe` and send Claude the output.

**Board still says "Not live"** — nothing new has arrived since the backfill, or
the run window was closed. The banner only clears once a message newer than 3
days old is in the database.

**Everything stops after the PC restarts** — it isn't a service yet. Open the
window and run step 7 again. Worth turning into a scheduled task once it's proven.

---

## What this does not do

Broadcasts and blasts. That needs the official WhatsApp Business API on a
separate number — doing it through a QR-linked tool is exactly what gets numbers
banned. See §3 of the AI WhatsApp agent brief.
