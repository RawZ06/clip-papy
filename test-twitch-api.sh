#!/bin/bash

# Charger les variables d'environnement
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# Vérifier que les variables sont définies
if [ -z "$TWITCH_CLIENT_ID" ] || [ -z "$TWITCH_CLIENT_SECRET" ]; then
  echo "❌ Variables d'environnement manquantes (TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET)"
  exit 1
fi

echo "🔑 Obtention du token d'accès..."
TOKEN=$(curl -s -X POST "https://id.twitch.tv/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=$TWITCH_CLIENT_ID&client_secret=$TWITCH_CLIENT_SECRET&grant_type=client_credentials" | jq -r '.access_token')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "❌ Impossible d'obtenir un token"
  exit 1
fi

echo "✅ Token obtenu"

echo ""
echo "👤 Obtention de l'ID du broadcaster..."
BROADCASTER_ID=$(curl -s "https://api.twitch.tv/helix/users?login=papy_grant" \
  -H "Client-ID: $TWITCH_CLIENT_ID" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.data[0].id')

echo "✅ Broadcaster ID: $BROADCASTER_ID"

echo ""
echo "🎬 === Test 1: Recherche du clip par ID ==="
CLIP_ID="JoyousAmorphousMageAsianGlow-vZzeHcsGQZvWicAZ"
CLIP_BY_ID=$(curl -s "https://api.twitch.tv/helix/clips?id=$CLIP_ID" \
  -H "Client-ID: $TWITCH_CLIENT_ID" \
  -H "Authorization: Bearer $TOKEN")

echo "$CLIP_BY_ID" | jq

if echo "$CLIP_BY_ID" | jq -e '.data[0]' > /dev/null 2>&1; then
  echo "✅ Le clip est accessible par ID"
else
  echo "❌ Le clip n'est PAS accessible par ID"
fi

echo ""
echo "🎬 === Test 2: Recherche du clip via broadcaster_id (TOUTES les pages) ==="
echo "Parcours de toutes les pages disponibles..."

FOUND=false
CURSOR=""
PAGE=1
TOTAL_CLIPS=0

while true; do
  if [ -z "$CURSOR" ]; then
    URL="https://api.twitch.tv/helix/clips?broadcaster_id=$BROADCASTER_ID&first=100"
  else
    URL="https://api.twitch.tv/helix/clips?broadcaster_id=$BROADCASTER_ID&first=100&after=$CURSOR"
  fi

  RESPONSE=$(curl -s "$URL" \
    -H "Client-ID: $TWITCH_CLIENT_ID" \
    -H "Authorization: Bearer $TOKEN")

  # Compter les clips de cette page
  PAGE_COUNT=$(echo "$RESPONSE" | jq '.data | length')
  TOTAL_CLIPS=$((TOTAL_CLIPS + PAGE_COUNT))

  # Chercher le clip dans cette page
  FOUND_IN_PAGE=$(echo "$RESPONSE" | jq -r ".data[] | select(.id == \"$CLIP_ID\") | .id")

  if [ -n "$FOUND_IN_PAGE" ]; then
    echo "✅ Clip TROUVÉ à la page $PAGE !"
    echo "   Total de clips parcourus: $TOTAL_CLIPS"
    FOUND=true
    break
  fi

  CURSOR=$(echo "$RESPONSE" | jq -r '.pagination.cursor // empty')

  if [ -z "$CURSOR" ]; then
    echo "Fin de la pagination (page $PAGE)"
    break
  fi

  echo "Page $PAGE: $PAGE_COUNT clips, total: $TOTAL_CLIPS (clip non trouvé, suite...)"
  PAGE=$((PAGE + 1))
done

echo ""
if [ "$FOUND" = false ]; then
  echo "❌ Le clip n'est PAS retourné par broadcaster_id"
  echo "   Total de pages parcourues: $PAGE"
  echo "   Total de clips parcourus: $TOTAL_CLIPS"
fi

echo ""
echo "📊 === Clips autour de la date du clip manquant ==="
curl -s "https://api.twitch.tv/helix/clips?broadcaster_id=$BROADCASTER_ID&first=100" \
  -H "Client-ID: $TWITCH_CLIENT_ID" \
  -H "Authorization: Bearer $TOKEN" | \
  jq -r '.data[] | select(.created_at >= "2025-11-16T20:30:00Z" and .created_at <= "2025-11-16T21:30:00Z") | "\(.created_at) | \(.id) | \(.title)"'
