# Trains — Station Boards

A public website showing live departure and arrival boards for UK mainline railway stations. Visitors select a station and see its real-time board.

## Language

**Station**:
A UK mainline National Rail station, identified by a 3-letter CRS code (e.g. `KGX` = London King's Cross). London Underground, metro, and tram are out of scope for v1.
_Avoid_: stop, terminus, depot

**CRS code**:
The 3-letter identifier for a Station. The user-facing identity of a Station across search, selection, and API calls.
_Avoid_: station code, TIPLOC, STANOX (those are internal timetable identifiers, not user-facing)

**Service**:
A single scheduled train run between an origin and a destination, operated by one Operator. The unit that departs from or arrives at a Station.
_Avoid_: train, journey, trip (those are colloquial or end-to-end; a Service is the scheduled railway unit)

**Operator (TOC)**:
The Train Operating Company that runs a Service (e.g. LNER, GWR).
_Avoid_: carrier, provider, company

**Departure**:
A Service scheduled to leave a Station.
_Avoid_: outbound, outbound train

**Arrival**:
A Service scheduled to arrive at a Station.
_Avoid_: inbound, inbound train

**Board**:
The live, time-ordered list of Departures (a Departures board) or Arrivals (an Arrivals board) at a Station.
_Avoid_: screen, display, timetable (timetable implies the static schedule, not the live board)

**Scheduled time**:
The time a Service is timetabled to depart/arrive, as published.
_Avoid_: planned time, timetable time

**Expected time**:
The real-time predicted time a Service will depart/arrive, updated as the Service progresses. May differ from Scheduled time (delayed/early) or be "On time".
_Avoid_: actual time (Actual is when it truly happened, in the past; Expected is the live prediction)

**Actual time**:
The time a Service truly departed/arrived, known only after the event.
_Avoid_: real time, final time

**Platform**:
The numbered (or lettered) platform at a Station that a Service is assigned to. A platform value is either **provisional** (planned/scheduled, not yet confirmed by the station) or **confirmed** (live, announced by the station). The distinction matters: a provisional platform can still change.
_Avoid_: berth, stand

**Cancellation**:
A Service that was scheduled but will not run, or will not call at this Station. Has a reason code.
_Avoid_: dropped, removed
