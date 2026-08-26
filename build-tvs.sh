#!/bin/bash
echo "Building Smart TV packages..."

# Build Samsung Tizen (.wgt)
if command -v tizen &> /dev/null; then
    tizen package -t wgt -s BlazingCert -- .
    echo "✅ Samsung Tizen .wgt created"
else
    echo "⚠️  Tizen CLI not installed. Skipping .wgt build (requires Tizen Studio)."
    # Fallback to simple zip for manual upload
    zip -r blazing-tizen.wgt * -x "*.git*" "*.DS_Store*" "build-tvs.sh"
    echo "✅ Created generic blazing-tizen.wgt fallback"
fi

# Build LG webOS (.ipk)
if command -v ares-package &> /dev/null; then
    ares-package . -o ./
    echo "✅ LG webOS .ipk created"
else
    echo "⚠️  webOS CLI not installed. Skipping .ipk build (requires webOS TV SDK)."
fi
