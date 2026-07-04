# P2P File Share

A complete, production-ready browser-to-browser file sharing platform built with WebRTC DataChannel. Files travel directly between browsers with no server storage.

## 🌟 Introduction

P2P File Share enables secure, fast, and private file sharing directly between web browsers. Using WebRTC technology, files are transferred peer-to-peer with end-to-end encryption, ensuring your data never passes through or is stored on any server.

## ✨ Features

### Rooms
- Create and join rooms with unique IDs
- Random or custom room IDs
- Optional password protection
- Copy room link and QR code for easy sharing
- Auto-delete empty rooms
- Lock/unlock rooms (host only)

### Users
- Custom nicknames with persistent storage
- Random colorful avatars
- Real-time online users list
- Host badge for room creators
- Join/leave notifications
- Kick users (host only)

### File Sharing
- Share any file type and size
- Multiple file transfers simultaneously
- Drag & drop support
- Folder sharing with structure preservation
- Send to everyone or selected users
- Accept/Reject incoming files
- Cancel transfers anytime
- Parallel transfers with queue management
- Real-time progress tracking
- Transfer speed and ETA display
- File type icons

### Preview
- Image preview (JPG, PNG, GIF, WebP)
- Video preview (MP4, WebM)
- Audio preview (MP3, WAV, OGG)
- PDF preview

### Chat
- Real-time room chat
- Emoji picker with 70+ emojis
- System messages for events
- Timestamped messages

### Security
- WebRTC end-to-end encryption
- Password-protected rooms
- Room locking
- User kick functionality
- No server file storage

### Connectivity
- Google STUN servers for NAT traversal
- TURN server support (configurable)
- Auto-reconnect on disconnection
- Connection status indicator

### UI/UX
- Mobile-first responsive design
- Dark theme with glass morphism
- Smooth animations and transitions
- Toast notifications
- Loading screen
- Clean, modern interface

## 📋 Requirements

- Node.js 18.0.0 or higher
- Modern web browser with WebRTC support:
  - Chrome 90+
  - Firefox 88+
  - Safari 15+
  - Edge 90+

## 🚀 Installation

### Local Development

1. Clone or download the project:
```bash
git clone <your-repo-url>
cd project