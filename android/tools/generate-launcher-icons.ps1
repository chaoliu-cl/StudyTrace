param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$source = Join-Path $repoRoot 'StudyTrace/studytracelogo.icon/Assets/ChatGPT Image May 17, 2026, 11_33_24 PM 2.png'
$resources = Join-Path $repoRoot 'android/app/src/main/res'
$storeAssets = Join-Path $repoRoot 'AppStoreAssets/Android'
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('studytrace-icons-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $scratch, $storeAssets | Out-Null

function Invoke-Magick {
    & magick @args
    if ($LASTEXITCODE -ne 0) { throw 'ImageMagick failed while generating StudyTrace icons.' }
}

# Crop inside the existing tile's rounded corners to make the Play image
# square and full bleed without changing the research logo itself.
$playIcon = Join-Path $storeAssets 'play-icon-512.png'
Invoke-Magick $source -crop 998x998+128+128 +repage -resize 512x512 -alpha off -alpha on -strip ('PNG32:' + $playIcon)

# Extract the same symbol for the adaptive foreground. Preserve all pixels
# inside the magnifying glass, including the blue bars on the white figure.
$cropped = Join-Path $scratch 'cropped.png'
$mask = Join-Path $scratch 'mask.png'
$symbol = Join-Path $scratch 'symbol.png'
Invoke-Magick $source -crop 920x950+200+160 +repage $cropped
Invoke-Magick $cropped -fx 'hypot(i-424,j-425)<380 ? 1 : min(1,max(0,5*(max(r-b,g-b)+0.2)))' -alpha off $mask
Invoke-Magick $cropped $mask -compose CopyOpacity -composite -trim +repage $symbol

# Android adaptive icons have a 108dp canvas and a smaller visible mask.
# Keep the symbol inside the safe region for circle and squircle launchers.
$foregroundDir = Join-Path $resources 'drawable-nodpi'
New-Item -ItemType Directory -Force -Path $foregroundDir | Out-Null
Invoke-Magick -size 432x432 xc:none '(' $symbol -resize 216x216 ')' -gravity center -compose Over -composite -strip ('PNG32:' + (Join-Path $foregroundDir 'ic_launcher_foreground.png'))

# Android 13 themed icons use the same symbol as a monochrome alpha mask.
$monoSymbol = Join-Path $scratch 'mono-symbol.png'
Invoke-Magick $cropped -fx 'min(1,max(0,5*(max(r-b,g-b)+0.2)))' -alpha off $mask
Invoke-Magick $cropped $mask -compose CopyOpacity -composite -trim +repage -channel RGB -fill white -colorize 100 +channel $monoSymbol
Invoke-Magick -size 432x432 xc:none '(' $monoSymbol -resize 216x216 ')' -gravity center -compose Over -composite -strip ('PNG32:' + (Join-Path $foregroundDir 'ic_launcher_monochrome.png'))

$densities = [ordered]@{ mdpi = 48; hdpi = 72; xhdpi = 96; xxhdpi = 144; xxxhdpi = 192 }
foreach ($density in $densities.GetEnumerator()) {
    $directory = Join-Path $resources ('mipmap-' + $density.Key)
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    Invoke-Magick $playIcon -resize ($density.Value.ToString() + 'x' + $density.Value) -strip ('PNG24:' + (Join-Path $directory 'ic_launcher.png'))
}

Write-Output "Generated launcher resources and $playIcon"
