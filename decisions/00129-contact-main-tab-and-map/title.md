Promoted Contact from a Settings tab to its own main admin tab, fixed the
address field's misleading "one address line per line" wording, and gave
the Contact page a real map: address-derived by default, or precisely
placed with a hand-rolled click-to-pin picker — closing the same class of
link/link-target desync `phoneHref`/`emailHref` already fixed, this time for
the map iframe's `src`, and generalizing the href scheme-injection guard to
cover it.
