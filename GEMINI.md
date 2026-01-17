# Project Overview

This is the personal academic portfolio website for **Linghao Zhuang** (庄凌浩). It showcases his biography, research news, publications, professional experience, and awards. The project is hosted on GitHub Pages.

**Key Technologies:**
*   **HTML5:** Semantic structure for the single-page layout.
*   **CSS:** Custom styling (primarily `apple.css`) for a clean, modern aesthetic.
*   **JavaScript:** Minimal vanilla JS for interactive elements like scroll-triggered animations, navigation highlighting, and a "back to top" button.

# Directory Overview

The project structure is flat and straightforward, typical for a static personal site.

## Key Files

*   **`index.html`**: The core of the website. It contains all the content (text, links, structure) including:
    *   **Sidebar:** Profile card (photo, social links, contact) and navigation menu.
    *   **Main Content:** Sections for Biography, News, Selected Publications, Experience, and Awards.
    *   **Inline Script:** Handles scroll events for section visibility (fade-in), active navigation state, and the back-to-top button.
*   **`apple.css`**: The primary stylesheet linked in `index.html`. It likely defines the layout (flex/grid), typography, and color scheme.
*   **`images/`**: Contains all static assets used on the site:
    *   Personal headshots (`headshot.jpg`).
    *   Institution logos (`casia.jpg`, `whu.jpeg`, `xjtu.jpg`).
    *   Publication teaser images/thumbnails (`ActiveSSF.png`, `Scientific_Data.png`, etc.).
*   **`jemdoc.css`**: An existing stylesheet file. **Note:** It is *not* currently linked in `index.html`. It may be a remnant from a previous version of the site (jemdoc is a popular text-based site generator for academics) or a fallback file.

# Usage & Maintenance

Since this is a static site without a build process, updates are made directly to the source files.

## Common Tasks

1.  **Updating Content:**
    *   Edit **`index.html`** directly.
    *   Locate the relevant `<section>` (e.g., `#news`, `#publications`).
    *   Copy an existing item block (like a `.news-card` or `.pub-card`) and modify the content to add new entries.

2.  **Adding Images:**
    *   Place new image files in the **`images/`** directory.
    *   Reference them in `index.html` using relative paths (e.g., `src="images/new-paper.png"`).

3.  **Deployment:**
    *   Committing and pushing changes to the `main` (or `master`) branch of the GitHub repository should automatically trigger a GitHub Pages build/update.

## Development Conventions

*   **Style:** The site aims for a clean, "Apple-like" design (inferred from `apple.css`). Maintain consistent spacing, typography, and card layouts when adding new content.
*   **Structure:** Keep the single-page format. Use semantic HTML tags (`<section>`, `<article>`, `<time>`).
*   **JavaScript:** Keep it lightweight. Avoid adding heavy libraries unless necessary. The current script uses `IntersectionObserver` for performance-friendly scroll effects.
