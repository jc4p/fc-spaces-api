import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import uuid4 from 'uuid4';

// Load environment variables
const APP_ACCESS_KEY = process.env.APP_ACCESS_KEY;
const APP_SECRET_KEY = process.env.APP_SECRET_KEY;
const TEMPLATE_ID = process.env.TEMPLATE_ID;
const HMS_API_BASE = process.env.HMS_API_BASE || 'https://api.100ms.live/v2';
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '600000', 10);
const MAX_REQUESTS_PER_WINDOW = parseInt(process.env.MAX_REQUESTS_PER_WINDOW || '300', 10);
const ROOM_NAME_PREFIX = process.env.ROOM_NAME_PREFIX || 'fariscope-room';
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
const ROOM_TIMEOUT_MS = parseInt(process.env.ROOM_TIMEOUT_MS || '300000', 10); // 5 minutes

// Token management
let managementToken = '';
let tokenGeneratedAt = 0;
const TOKEN_VALIDITY_DURATION = 12 * 60 * 60 * 1000; // 12 hours

// In-memory storage
const roomStore = new Map();
const rateLimit = new Map();

// Function to generate management token
function generateManagementToken() {
  if (!APP_ACCESS_KEY || !APP_SECRET_KEY) {
    throw new Error('APP_ACCESS_KEY and APP_SECRET_KEY must be provided in environment variables');
  }

  const payload = {
    access_key: APP_ACCESS_KEY,
    type: 'management',
    version: 2,
    iat: Math.floor(Date.now() / 1000),
    nbf: Math.floor(Date.now() / 1000)
  };

  return jwt.sign(
    payload,
    APP_SECRET_KEY,
    {
      algorithm: 'HS256',
      expiresIn: '24h',
      jwtid: uuid4()
    }
  );
}

// Generate initial token
function generateInitialToken() {
  managementToken = generateManagementToken();
  tokenGeneratedAt = Date.now();
  console.log('🔑 Management token generated');
}

// Check if token needs refresh
function getValidToken() {
  const now = Date.now();
  if (!managementToken || now - tokenGeneratedAt > TOKEN_VALIDITY_DURATION) {
    try {
      managementToken = generateManagementToken();
      tokenGeneratedAt = now;
      console.log('🔄 Management token refreshed');
    } catch (error) {
      console.error('❌ Failed to refresh management token:', error.message);
      // If we have an existing token, keep using it rather than failing
      if (!managementToken) {
        throw error; // Only throw if we have no token at all
      }
    }
  }
  return managementToken;
}

// Helper functions
async function fetchFromHMS(endpoint, options = {}) {
  try {
    // Get a valid token for each API call
    const token = getValidToken();
    
    const response = await fetch(`${HMS_API_BASE}${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(error.message || `HMS API error: ${response.statusText}`);
    }
    
    return response.json();
  } catch (error) {
    throw new Error(`HMS API error: ${error.message}`);
  }
}

async function createRoomCode(roomId, role) {
  return fetchFromHMS(`/room-codes/room/${roomId}/role/${role}`, {
    method: 'POST'
  });
}

async function findExistingRoom(roomName) {
  try {
    const response = await fetchFromHMS(`/rooms?name=${roomName}`);
    
    // Handle empty response or no data
    if (!response || !response.data) {
      console.log(`No rooms found with name: ${roomName}`);
      return null;
    }
    
    return response.data.find(room => room.name === roomName);
  } catch (error) {
    console.error('Error finding room:', error);
    return null;
  }
}

async function enableRoom(roomId) {
  return fetchFromHMS(`/rooms/${roomId}`, {
    method: 'POST',
    body: JSON.stringify({
      enabled: true
    })
  });
}

async function disableRoom(roomId) {
  return fetchFromHMS(`/rooms/${roomId}`, {
    method: 'POST',
    body: JSON.stringify({
      enabled: false
    })
  });
}

function validateAddress(address) {
  return typeof address === 'string' && 
         address.startsWith('0x') && 
         address.length === 42 &&
         /^0x[0-9a-fA-F]{40}$/.test(address);
}

function validateFid(fid) {
  const numFid = Number(fid);
  return !isNaN(numFid) && numFid > 0 && Number.isInteger(numFid);
}

async function fetchUsername(fid) {
  if (!NEYNAR_API_KEY) {
    console.warn('NEYNAR_API_KEY not set, using fallback room name');
    return null;
  }
  
  try {
    const response = await fetch(`https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`, {
      headers: {
        'accept': 'application/json',
        'x-api-key': NEYNAR_API_KEY
      }
    });
    
    if (!response.ok) {
      throw new Error(`Neynar API error: ${response.statusText}`);
    }
    
    const data = await response.json();
    if (data.users && data.users.length > 0 && data.users[0].username) {
      return data.users[0].username;
    }
    return null;
  } catch (error) {
    console.error('Error fetching username:', error);
    return null;
  }
}

async function checkInactiveRooms() {
  const now = Date.now();
  const cutoff = now - ROOM_TIMEOUT_MS;
  
  for (const [roomId, roomData] of roomStore.entries()) {
    if (roomData.disabled) continue;
    
    const lastActivityTime = new Date(roomData.lastActivity).getTime();
    if (lastActivityTime < cutoff) {
      console.log(`Room ${roomId} inactive for more than ${ROOM_TIMEOUT_MS/60000} minutes, disabling`);
      try {
        await disableRoom(roomId);
        roomStore.set(roomId, {
          ...roomData,
          disabled: true,
          lastActivity: new Date().toISOString()
        });
      } catch (error) {
        console.error(`Failed to disable inactive room ${roomId}:`, error);
      }
    }
  }
}

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  
  // Clean up old entries
  for (const [key, data] of rateLimit.entries()) {
    if (data.timestamp < windowStart) {
      rateLimit.delete(key);
    }
  }
  
  const userData = rateLimit.get(ip) || { count: 0, timestamp: now };
  
  if (userData.count >= MAX_REQUESTS_PER_WINDOW) {
    throw new Error('Rate limit exceeded. Please try again later.');
  }
  
  rateLimit.set(ip, {
    count: userData.count + 1,
    timestamp: now
  });
}

// Initialize room store from 100ms
async function initializeRoomStore() {
  try {
    console.log('🔄 Syncing rooms with 100ms...');
    const response = await fetchFromHMS(`/rooms?template_id=${TEMPLATE_ID}&enabled=true`);
    
    // Handle empty response
    if (!response || !response.data) {
      console.log('✅ No active rooms found in 100ms');
      return;
    }
    
    // Extract room name pattern to get FID
    const fidPattern = new RegExp(`${ROOM_NAME_PREFIX}-(\\d+)`);
    
    // Filter for fariscope rooms only
    const fariscopeRooms = response.data.filter(room => room.name.startsWith(ROOM_NAME_PREFIX));
    
    for (const room of fariscopeRooms) {
      const match = room.name.match(fidPattern);
      if (match) {
        const fid = match[1];
        roomStore.set(room.id, {
          fid,
          roomName: room.name,
          createdAt: room.created_at,
          lastActivity: new Date().toISOString()
        });
      }
    }
    
    console.log(`✅ Synced ${roomStore.size} active Fariscope rooms`);
  } catch (error) {
    console.error('❌ Failed to sync rooms:', error.message);
  }
}

// Create server
const app = new Elysia()
  .use(cors())
  .onError(({ code, error, set }) => {
    console.error(`Error [${code}]:`, error);
    set.status = code === 'VALIDATION' ? 400 : 500;
    return { error: error.message };
  })
  .get('/rooms', async ({ headers }) => {
    try {
      checkRateLimit(headers['x-forwarded-for'] || 'unknown');
      
      const response = await fetchFromHMS(`/rooms?template_id=${TEMPLATE_ID}&enabled=true`);
      
      // Handle empty response
      if (!response || !response.data) {
        return {
          limit: 10,
          data: []
        };
      }
      
      // Filter for fariscope rooms and enhance with metadata
      const enhancedData = response.data
        .filter(room => room.name.startsWith(ROOM_NAME_PREFIX))
        .map(room => ({
          ...room,
          metadata: roomStore.get(room.id) || null
        }));
      
      return {
        limit: response.limit || 10,
        data: enhancedData
      };
    } catch (error) {
      console.error('Error fetching rooms:', error);
      return {
        limit: 10,
        data: []
      };
    }
  })
  .post('/create-room', async ({ body, headers }) => {
    try {
      checkRateLimit(headers['x-forwarded-for'] || 'unknown');
      
      const { address, fid } = body;
      
      if (!address || !fid) {
        throw new Error('Missing required fields: address and fid');
      }
      
      if (!validateAddress(address)) {
        throw new Error('Invalid ETH address format');
      }
      
      if (!validateFid(fid)) {
        throw new Error('Invalid FID format');
      }

      // Fetch username from Neynar if API key is available
      const username = await fetchUsername(fid);
      // Filter username to only include allowed characters (a-z, A-Z, 0-9, and . - :)
      const cleanUsername = username ? username.replace(/[^a-zA-Z0-9.\-:]/g, '') : null;
      const displayName = cleanUsername ? `Chat with ${cleanUsername}` : `Audio Chat With FID: ${fid}`;
      const roomName = `${ROOM_NAME_PREFIX}-${fid}`;
      
      // Check for existing room
      const existingRoom = await findExistingRoom(roomName);
      let room;

      if (existingRoom) {
        if (!existingRoom.enabled) {
          // Enable the existing room
          room = await enableRoom(existingRoom.id);
          console.log(`Re-enabled existing room: ${roomName}`);
        } else {
          room = existingRoom;
          console.log(`Using existing enabled room: ${roomName}`);
        }
      } else {
        // Create new room
        room = await fetchFromHMS('/rooms', {
          method: 'POST',
          body: JSON.stringify({
            name: roomName,
            description: displayName,
            template_id: TEMPLATE_ID
          })
        });
        console.log(`Created new room: ${roomName} with display name: ${displayName}`);
      }

      // Create streamer code
      const streamerCode = await createRoomCode(room.id, 'fariscope-streamer');

      // Store room info
      roomStore.set(room.id, {
        fid,
        address,
        roomName,
        createdAt: room.created_at || new Date().toISOString(),
        lastActivity: new Date().toISOString()
      });

      return {
        roomId: room.id,
        code: streamerCode.code,
        status: existingRoom ? (existingRoom.enabled ? 'existing' : 'reenabled') : 'created'
      };
    } catch (error) {
      throw new Error(error.message);
    }
  })
  .post('/join-room', async ({ body, headers }) => {
    try {
      checkRateLimit(headers['x-forwarded-for'] || 'unknown');
      
      const { roomId, fid, address } = body;
      
      if (!roomId || !fid) {
        throw new Error('Missing required fields: roomId and fid');
      }
      
      if (!validateFid(fid)) {
        throw new Error('Invalid FID format');
      }
      
      if (address && !validateAddress(address)) {
        throw new Error('Invalid ETH address format');
      }
      
      const roomData = roomStore.get(roomId);
      if (!roomData) {
        throw new Error('Room not found');
      }
      
      // Determine if the user is the room creator
      const isCreator = roomData.fid === fid && (!address || roomData.address === address);
      const role = isCreator ? 'fariscope-streamer' : 'fariscope-viewer';
      
      // Create appropriate role code
      const roleCode = await createRoomCode(roomId, role);
      
      // Update last activity
      roomStore.set(roomId, {
        ...roomData,
        lastActivity: new Date().toISOString()
      });

      return {
        code: roleCode.code,
        role: role,
        serverIsCreator: isCreator
      };
    } catch (error) {
      throw new Error(error.message);
    }
  })
  .post('/disable-room', async ({ body, headers }) => {
    try {
      checkRateLimit(headers['x-forwarded-for'] || 'unknown');
      
      const { roomId, address, fid } = body;
      
      if (!roomId || !address || !fid) {
        throw new Error('Missing required fields: roomId, address, and fid');
      }
      
      if (!validateAddress(address)) {
        throw new Error('Invalid ETH address format');
      }
      
      if (!validateFid(fid)) {
        throw new Error('Invalid FID format');
      }
      
      // Check if room exists in our store
      const roomData = roomStore.get(roomId);
      if (!roomData) {
        throw new Error('Room not found');
      }
      
      // Verify that the requester is the room creator
      if (roomData.fid !== fid || roomData.address !== address) {
        throw new Error('Only the room creator can disable this room');
      }
      
      // Disable the room
      await disableRoom(roomId);
      
      // Update room status in our store
      roomStore.set(roomId, {
        ...roomData,
        disabled: true,
        lastActivity: new Date().toISOString()
      });
      
      return {
        status: 'success',
        message: 'Room disabled successfully'
      };
    } catch (error) {
      throw new Error(error.message);
    }
  })
  .listen({
    hostname: '0.0.0.0',
    port: 8000
  });

// Setup periodic room activity checking
const INACTIVE_CHECK_INTERVAL = 60000; // Check every minute

// Initialize token and rooms on startup
try {
  generateInitialToken();
  initializeRoomStore();
  
  // Start periodic checking for inactive rooms
  setInterval(checkInactiveRooms, INACTIVE_CHECK_INTERVAL);
  console.log(`🕒 Room inactivity checker started (timeout: ${ROOM_TIMEOUT_MS/60000} minutes)`);
} catch (error) {
  console.error('❌ Initialization error:', error.message);
  process.exit(1);
}

console.log(`🦊 Fariscope server is running at ${app.server?.hostname}:${app.server?.port}`);
