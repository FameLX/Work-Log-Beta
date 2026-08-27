# Work Log build: inline the split source (html + css + js) into one deployable HTML.
# Usage:  .\build.ps1                 -> builds dev into index.html (beta)
#         .\build.ps1 -Src "path.html" -Out "out.html"
# The dev source lives in "1. Project/Work Log Dev/" as three files:
#   worklog dev.html   (markup, references the other two via <link>/<script src>)
#   worklog dev.css    (styles)
#   worklog dev.js     (app logic)
# This script replaces the two reference tags with inline <style>/<script> blocks,
# producing the same single-file HTML that was shipped before the split.
param(
    [string]$Src = "$PSScriptRoot\1. Project\Work Log Dev\worklog dev.html",
    [string]$Out = "$PSScriptRoot\index.html"
)
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$dir  = Split-Path $Src
$html = [IO.File]::ReadAllText($Src, $utf8)

$linkRx   = '(?m)^[ \t]*<link rel="stylesheet" href="((?!https?:)[^"]+\.css)" />\r?\n'
$scriptRx = '(?m)^[ \t]*<script src="((?!https?:)[^"]+\.js)"></script>\r?\n'

$m = [regex]::Match($html, $linkRx)
if (-not $m.Success) { throw "No local <link rel=stylesheet> tag found in $Src" }
$css  = [IO.File]::ReadAllText((Join-Path $dir $m.Groups[1].Value), $utf8)
$html = $html.Substring(0, $m.Index) + "    <style>`n" + $css + "    </style>`n" + $html.Substring($m.Index + $m.Length)

$m = [regex]::Match($html, $scriptRx)
if (-not $m.Success) { throw "No local <script src> tag found in $Src" }
$js   = [IO.File]::ReadAllText((Join-Path $dir $m.Groups[1].Value), $utf8)
$html = $html.Substring(0, $m.Index) + "    <script>`n" + $js + "    </script>`n" + $html.Substring($m.Index + $m.Length)

[IO.File]::WriteAllText($Out, $html, $utf8)
Write-Host "Built $Out ($([math]::Round((Get-Item $Out).Length/1KB)) KB)"
