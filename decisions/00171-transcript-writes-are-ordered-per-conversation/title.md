The worker's transcript writer is serialised per conversation and snapshots inside its lock, so a delayed earlier write can no longer leave the file missing the latest turn
