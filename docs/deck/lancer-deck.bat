@echo off
REM ============================================================================
REM  Deck Styx pour Castle DAO, 4 septembre 2026.
REM
REM  Double-clic, et la page s'ouvre. Rien a installer, aucun serveur, aucune
REM  connexion : la police Newsreader est inlinee dans le fichier HTML, donc le
REM  deck rend a l'identique sur une machine hors reseau. Un <link> vers un CDN
REM  de polices serait retombe en silence sur Georgia, et la planche aurait
REM  change de voix sans que personne le voie.
REM
REM  Le chemin est resolu depuis l'emplacement de ce fichier (%~dp0), donc le
REM  dossier docs\deck peut etre deplace ou copie sur une cle sans rien casser.
REM ============================================================================

setlocal
set "DECK=%~dp0castle-dao-2026-09-04.html"

if not exist "%DECK%" (
    echo.
    echo   Fichier introuvable :
    echo     %DECK%
    echo.
    echo   Ce .bat doit rester a cote du fichier HTML. Si tu l'as deplace seul,
    echo   remets-le dans docs\deck\ ou copie les deux ensemble.
    echo.
    pause
    exit /b 1
)

echo.
echo   Ouverture du deck Styx  --  Castle DAO, 4 septembre 2026
echo.
echo   11 planches, defilement vertical.
echo   Export PDF : Ctrl+P, marges "Aucune", et COCHER "Graphiques
echo   d'arriere-plan", sinon la page sort en noir sur blanc.
echo.

REM `start ""` : le premier argument vide est le TITRE de la fenetre, pas le
REM fichier. Sans lui, cmd prend le chemin pour un titre et n'ouvre rien des
REM que le chemin contient un espace.
start "" "%DECK%"

endlocal
