# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mapa Lino is a Progressive Web Application (PWA) for visualizing electrical/geographical maps using KMZ/KML files. It's built with vanilla HTML, CSS, and JavaScript with a PHP backend for file management and API endpoints.

## Architecture

### Frontend Structure
- **index.html**: Main public viewer application with map visualization
- **admin.html**: Administrative interface for managing cities, uploads, and configuration
- **assets/script.js**: Core JavaScript with map functionality, file parsing, and UI management
- **assets/styles.css**: Complete CSS styling for both public and admin interfaces
- **service-worker.js**: PWA service worker for offline functionality and caching

### Backend Structure
- **api/**: PHP backend endpoints
  - **cities.php**: CRUD operations for city management (upload KMZ/KML files, manage metadata)
  - **message.php**: Home page message management
  - **upload_logo.php**: Logo upload and management
  - **reverse_geocode.php** & **revgeo.php**: Geocoding services
  - **auth.php**: Authentication system for admin access
- **data/**: JSON storage for app messages
- **uploads/**: File storage
  - **uploads/cities/**: KMZ/KML files and city metadata
  - **uploads/logo.png**: Application logo

### Key Technologies
- **Leaflet.js**: Interactive mapping library
- **JSZip**: KMZ file parsing
- **PHP**: Backend API and file handling
- **PWA features**: Service worker, offline functionality, app manifest

## Development Workflow

### Local Development
This is a vanilla web application that requires a web server to function properly due to:
- PHP backend requirements
- Service worker restrictions (HTTPS/localhost only)
- File upload functionality

**Start local server:** Use any PHP-compatible web server (Apache, Nginx, or PHP built-in server)
```bash
# Using PHP built-in server (recommended for development)
php -S localhost:8000

# Or using Python (if no PHP processing needed for testing)
python -m http.server 8000
```

### Testing the Application
- Access the public viewer at `/index.html`
- Access the admin panel at `/admin.html`
- Test PWA functionality and offline capabilities
- Verify KMZ/KML file upload and parsing
- Test service worker caching with browser dev tools (Application → Service Workers)

### No Build Process
This project uses vanilla technologies without build tools:
- No transpilation or bundling required
- Direct file editing and refresh workflow
- External dependencies loaded via CDN (Leaflet.js, JSZip)

### File Structure for Cities
- City data is stored in `uploads/cities/` 
- Each city has metadata in `uploads/cities/_index.json`
- KMZ/KML files are stored with generated unique filenames
- Cities can be marked as "default" for auto-loading

## Key Features

### Map Functionality
- Interactive map with Leaflet.js
- KMZ/KML file parsing and visualization
- Layer management for electrical lines/feeders and posts
- Search functionality by key/code
- Zoom-dependent marker visibility for performance
- Satellite and terrain view toggles

### Performance Optimizations
- Chunk-based parsing for large files (`CHUNK_SIZE = 1000`)
- Zoom-level based marker display (`Z_MARKERS_ON = 15`)
- Progressive label loading (`Z_LABELS_ON = 12`)
- Geometry simplification for better performance
- Persistent local caching with localStorage

### PWA Features
- Offline functionality via service worker
- App manifest for installation
- Cached external resources (Leaflet, JSZip)
- Fallback offline page

## Code Conventions

### JavaScript
- Uses ES6+ features with vanilla JavaScript
- Utility functions with short names (`$` for querySelector)
- Performance-focused with configurable constants
- Local storage for persistent data (keycodes, preferences)

### PHP
- Strict types enabled
- JSON API responses with consistent format
- File upload security measures
- Simple file-based data storage

### CSS
- Custom CSS with CSS variables for theming
- Responsive design with mobile-first approach
- Dark mode support via theme toggle

## Important Performance Constants

The application uses several performance-critical constants in `assets/script.js`:

```javascript
const Z_MARKERS_ON   = 15; // Show markers at this zoom level
const Z_LABELS_ON    = 12; // Show labels at this zoom level  
const CHUNK_SIZE     = 1000; // Batch size for parsing large files
const Z_POST_TEXT_ON = 14; // Post text labels zoom threshold
const MAX_POST_LABELS = 100; // Global limit for simultaneous labels
const LABEL_GRID_PX  = 96; // Screen sampling grid size
```

When modifying map performance, adjust these constants carefully as they directly impact:
- Memory usage with large KMZ/KML files
- Frame rate during zoom/pan operations
- Label rendering performance

## Security Features

- HTML escaping utilities (`escapeHtml`, `safeSetInnerHTML`)
- File upload validation and sanitization
- Session-based authentication for admin functions
- Content Security Policy considerations for external CDN resources