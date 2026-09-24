Two more gaps in the same concurrent-delete race: mkdir outside the try, and archive-failed-original now logs+continues instead of re-raising on a racy row-check
