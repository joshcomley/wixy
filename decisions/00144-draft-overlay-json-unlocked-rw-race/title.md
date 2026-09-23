Draft overlay.json reads/writes now share tree_lock() — closes an unlocked concurrent-access race (Windows PermissionError + possible lost updates)
