-- Blazing Games.app — the ONE icon that stands in for eight.
--
-- It replaces FitGirl / GOG / PS3 / PS4 / PS5 / PSP / Switch / Xbox 360
-- "Game Browser" (com.nookie.*, all eight in /Applications). Those eight stay
-- where they are; Markus removes them himself once this has earned it.
--
-- WHY A THIN LAUNCHER AND NOT A SECOND NATIVE CLIENT. The same games hub has
-- to run on the Mac, on the PS5's browser, and on the four televisions. A
-- native Mac app would be a second codebase for one of those six, and the
-- fleet already has the scar from that: a Tizen mock injected a trailerUrl
-- and a feature that never worked looked alive for a week. One codebase, six
-- surfaces, one place a bug can hide.
--
-- WHY COMET AND NOT `open location`. `open location` hands the URL to the
-- default browser as a TAB, which lands it among forty others. Chromium's
-- --app= flag gives a chromeless window with its own Dock entry, which is
-- what makes this feel like an app rather than a bookmark. Comet is the
-- browser this machine uses; ~/CLAUDE.md is explicit that Chrome is not.
--
-- This is HIS Comet on mac1, deliberately, and it is not the thing the
-- "mac2's Comet, never mac1's" rule forbids. That rule is about AGENTS
-- driving a browser for scraping. This is Markus clicking his own launcher
-- and using his own signed-in sessions, which is the whole point of it.
--
-- Rebuild with:  bash ~/Desktop/blazing-web/mac/build-app.sh

property defaultURL : "https://blazingstream.lyreosai.com/app/#games"
property cometBinary : "/Applications/Comet.app/Contents/MacOS/Comet"

on run
	set theURL to defaultURL
	-- A local override, for working on the hub without a deploy:
	--   echo 'http://127.0.0.1:8080/index.html#games' > ~/.blazing-games-url
	try
		set overridePath to (POSIX path of (path to home folder)) & ".blazing-games-url"
		set overrideText to do shell script "cat " & quoted form of overridePath
		if overrideText is not "" then set theURL to overrideText
	end try

	try
		do shell script "test -x " & quoted form of cometBinary
		-- Detached, and stdout/stderr thrown away. Without the redirect
		-- `do shell script` waits for the browser to EXIT, so the launcher
		-- would sit spinning for as long as Comet is open.
		do shell script quoted form of cometBinary & " --app=" & quoted form of theURL & " > /dev/null 2>&1 &"
	on error
		-- Comet is not installed. Say so rather than silently opening Chrome,
		-- which this machine is never allowed to do.
		display dialog "Comet is not at " & cometBinary & "." & return & return & ¬
			"Blazing Games opens in Comet. Install it, or open " & theURL & " by hand." ¬
			buttons {"OK"} default button "OK" with icon caution
	end try
end run
