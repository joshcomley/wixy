"""Reshape Cottage Aesthetics business working hours in Wix Bookings.

Target: Mon 10-19, Tue 10-19, Wed CLOSED, Thu 10-19, Fri 10-17, Sat 11-16, Sun closed.
(Wix default was Mon-Fri 10-18.) Wednesday is intentionally CLOSED on the booking
site even though Google shows it open — Purdi keeps Wed for phone enquiries.

Mechanism: the business "main schedule" (external id 4e0579a5-...) holds recurring
WORKING_HOURS MASTER events (one per weekday). We PATCH end times, POST /cancel the
Wednesday master, and POST-create a Saturday master. Auth via WIX_API_KEY env.

Run (PowerShell):
  $env:WIX_API_KEY = [Environment]::GetEnvironmentVariable('WIX_API_KEY','Machine')
  python tooling/set_hours.py

The MASTER event ids below were discovered via Query Events (type=WORKING_HOURS)
on schedule b77e2ef5-e931-4208-a6f1-3da3956ed8ef. If Wix regenerates them, re-query
and update the MASTERS map.
"""
import os, httpx

KEY = os.environ["WIX_API_KEY"]
SITE = "c721738f-2644-49e8-8865-fc10865db30f"
H = {"Authorization": KEY, "wix-site-id": SITE, "Content-Type": "application/json"}
BASE = "https://www.wixapis.com/calendar/v3/events"
SCHED = "b77e2ef5-e931-4208-a6f1-3da3956ed8ef"
EXT = "4e0579a5-491e-4e70-a872-d097eed6e520"

MASTERS = {
    "MON": "b77e2ef5e9314208a6f13da3956ed8ef0af1d11ae94c485f948d8faebb32a0c5",
    "TUE": "b77e2ef5e9314208a6f13da3956ed8ef44be43db55e8439abd810536ee06b961",
    "WED": "b77e2ef5e9314208a6f13da3956ed8efc05f3a39d7a043af96b9d9694451c104",
    "THU": "b77e2ef5e9314208a6f13da3956ed8efc3310e89549343668d4590ab931c4f99",
    "FRI": "b77e2ef5e9314208a6f13da3956ed8ef3ddc8246e2d846d99e1a349e9e50b9ae",
}


def set_end(day, new_hhmm):
    r = httpx.get(f"{BASE}/{MASTERS[day]}", headers=H, timeout=30)
    if r.status_code >= 300:
        print(f"  {day} GET FAIL [{r.status_code}] {r.text[:160]}"); return
    e = r.json()["event"]
    end = dict(e["end"]); end["localDate"] = end["localDate"][:11] + new_hhmm + ":00"; end.pop("utcDate", None)
    start = dict(e["start"]); start.pop("utcDate", None)
    ev = {"id": e["id"], "revision": e["revision"], "scheduleId": e["scheduleId"], "type": e["type"],
          "recurrenceType": e.get("recurrenceType", "MASTER"), "start": start, "end": end,
          "recurrenceRule": e["recurrenceRule"], "timeZone": e.get("timeZone", "Europe/London")}
    resp = httpx.patch(f"{BASE}/{e['id']}", headers=H, json={"event": ev}, timeout=30)
    print(f"  {day} -> end {new_hhmm}: [{resp.status_code}] " + ("OK" if resp.status_code < 300 else resp.text[:200]))


def cancel(day):
    resp = httpx.post(f"{BASE}/{MASTERS[day]}/cancel", headers=H, json={}, timeout=30)
    print(f"  {day} CANCEL: [{resp.status_code}] " + ("OK" if resp.status_code < 300 else resp.text[:200]))


def existing_days():
    body = {"fromLocalDate": "2026-07-06T00:00:00", "toLocalDate": "2026-07-12T23:59:59",
            "query": {"filter": {"externalScheduleId": EXT, "type": "WORKING_HOURS"}}}
    r = httpx.post(f"{BASE}/query", headers=H, json=body, timeout=30)
    return {d for e in r.json().get("events", []) for d in e.get("recurrenceRule", {}).get("days", [])}


def create_saturday():
    if "SATURDAY" in existing_days():
        print("  SAT already exists, skip"); return
    ev = {"scheduleId": SCHED, "type": "WORKING_HOURS", "recurrenceType": "MASTER",
          "start": {"localDate": "2026-07-11T11:00:00", "timeZone": "Europe/London"},
          "end": {"localDate": "2026-07-11T16:00:00", "timeZone": "Europe/London"},
          "recurrenceRule": {"frequency": "WEEKLY", "interval": 1, "days": ["SATURDAY"]},
          "timeZone": "Europe/London"}
    resp = httpx.post(BASE, headers=H, json={"event": ev}, timeout=30)
    print(f"  SAT create 11-16: [{resp.status_code}] " + ("OK" if resp.status_code < 300 else resp.text[:250]))


if __name__ == "__main__":
    print("Setting working hours...")
    set_end("MON", "19:00"); set_end("TUE", "19:00"); set_end("THU", "19:00"); set_end("FRI", "17:00")
    cancel("WED"); create_saturday()
    print("Current working days:", sorted(existing_days()))
