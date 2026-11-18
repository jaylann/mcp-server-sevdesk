/**
 * The pictograms of the server's own pages, as inline SVG (the pages' CSP loads no images besides
 * the favicon). They are the icons the Lanfermann system uses: the free Hugeicons set (MIT,
 * `licenses/icons/Hugeicons-MIT.txt`), path data copied unchanged from
 * `@hugeicons/core-free-icons` 4.4.0, drawn as 1.5 strokes on a 24-unit grid in `currentColor`.
 * Colours and sizes come from the stylesheet (`.ink` in `theme.ts` and the element an icon sits
 * in), because the CSP allows no `style` attributes. Icons are never in the accent.
 *
 * Every icon here is decoration next to text that says the same, so each is `aria-hidden`.
 */
import { type Html, trusted } from "./html.js";

const ICONS = {
  /** SquareLock02: a tier that waits for a person, the sign-in address. */
  lock:
    '<path d="M12 14.5V17.5M13 14.5C13 15.0523 12.5523 15.5 12 15.5C11.4477 15.5 11 15.0523 11 14.5C11 13.9477 11.4477 13.5 12 13.5C12.5523 13.5 13 13.9477 13 14.5Z"/>' +
    '<path d="M16.5 9V6.5C16.5 4.01472 14.4853 2 12 2C9.51471 2 7.49999 4.01472 7.49999 6.5V9"/>' +
    '<path d="M4.2678 18.8447C4.49268 20.515 5.87612 21.8235 7.55965 21.9009C8.97627 21.966 10.4153 22 12 22C13.5847 22 15.0237 21.966 16.4403 21.9009C18.1239 21.8235 19.5073 20.515 19.7322 18.8447C19.8789 17.7547 20 16.6376 20 15.5C20 14.3624 19.8789 13.2453 19.7322 12.1553C19.5073 10.485 18.1239 9.17649 16.4403 9.09909C15.0237 9.03397 13.5847 9 12 9C10.4153 9 8.97627 9.03397 7.55965 9.09909C5.87612 9.17649 4.49268 10.485 4.2678 12.1553C4.12104 13.2453 3.99999 14.3624 3.99999 15.5C3.99999 16.6376 4.12104 17.7547 4.2678 18.8447Z"/>',
  /** Inbox: the empty approval inbox. */
  inbox:
    '<path d="M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z"/>' +
    '<path d="M21.5 13.5H16.5743C15.7322 13.5 15.0706 14.2036 14.6995 14.9472C14.2963 15.7551 13.4889 16.5 12 16.5C10.5111 16.5 9.70373 15.7551 9.30054 14.9472C8.92942 14.2036 8.26777 13.5 7.42566 13.5H2.5"/>',
  /** Tick02. */
  check: '<path d="M5 14L8.5 17.5L19 6.5"/>',
  /** Clock01: time is the cause or the cure. */
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 8V12L14 14"/>',
  /** Alert02: a warning. */
  alert:
    '<path d="M13.9248 21H10.0752C5.44476 21 3.12955 21 2.27636 19.4939C1.42317 17.9879 2.60736 15.9914 4.97574 11.9985L6.90057 8.75333C9.17559 4.91778 10.3131 3 12 3C13.6869 3 14.8244 4.91777 17.0994 8.75332L19.0243 11.9985C21.3926 15.9914 22.5768 17.9879 21.7236 19.4939C20.8704 21 18.5552 21 13.9248 21Z"/>' +
    '<path d="M12 9V13"/>' +
    '<path d="M12.125 16.75H12M12.25 16.75C12.25 16.8881 12.1381 17 12 17C11.8619 17 11.75 16.8881 11.75 16.75C11.75 16.6119 11.8619 16.5 12 16.5C12.1381 16.5 12.25 16.6119 12.25 16.75Z"/>',
  /** AlertCircle: refused, failed or irreversible. */
  danger:
    '<circle cx="12" cy="12" r="10"/><path d="M12 8V12"/>' +
    '<path d="M12.125 15.75H12M12.25 15.75C12.25 15.8881 12.1381 16 12 16C11.8619 16 11.75 15.8881 11.75 15.75C11.75 15.6119 11.8619 15.5 12 15.5C12.1381 15.5 12.25 15.6119 12.25 15.75Z"/>',
  /** InformationCircle: a neutral fact. */
  info:
    '<circle cx="12" cy="12" r="10"/><path d="M12 16V12"/>' +
    '<path d="M12.125 8.25H12M12.25 8.25C12.25 8.11193 12.1381 8 12 8C11.8619 8 11.75 8.11193 11.75 8.25C11.75 8.38807 11.8619 8.5 12 8.5C12.1381 8.5 12.25 8.38807 12.25 8.25Z"/>',
  /** CheckmarkCircle02: it worked. */
  done:
    '<path d="M22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12Z"/>' +
    '<path d="M8 12.5L10.5 15L16 9"/>',
  /** Refresh: load again, or something changed. */
  refresh:
    '<path d="M20.0092 2V5.13219C20.0092 5.42605 19.6418 5.55908 19.4537 5.33333C17.6226 3.2875 14.9617 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12"/>',
  /** Upload04. */
  upload:
    '<path d="M5.25 21H18.75C18.9822 21 19.0983 21 19.196 20.9904C20.1456 20.8968 20.8968 20.1456 20.9904 19.196C21 19.0983 21 18.9822 21 18.75C21 18.5178 21 18.4017 20.9904 18.304C20.8968 17.3544 20.1456 16.6032 19.196 16.5096C19.0983 16.5 18.9822 16.5 18.75 16.5H17.0607C16.8324 16.5 16.7182 16.5 16.6087 16.5121C16.2317 16.5538 15.8742 16.7018 15.5781 16.939C15.4921 17.0079 15.4114 17.0886 15.25 17.25C15.0886 17.4114 15.0079 17.4921 14.9219 17.561C14.6258 17.7982 14.2683 17.9462 13.8913 17.9879C13.7818 18 13.6676 18 13.4393 18H10.5607C10.3324 18 10.2182 18 10.1087 17.9879C9.73165 17.9462 9.37423 17.7982 9.07814 17.561C8.99213 17.4921 8.91142 17.4114 8.75 17.25C8.58858 17.0886 8.50787 17.0079 8.42186 16.939C8.12577 16.7018 7.76835 16.5538 7.3913 16.5121C7.28177 16.5 7.16763 16.5 6.93934 16.5H5.25C5.01783 16.5 4.90175 16.5 4.80397 16.5096C3.85441 16.6032 3.10315 17.3544 3.00963 18.304C3 18.4017 3 18.5178 3 18.75C3 18.9822 3 19.0983 3.00963 19.196C3.10315 20.1456 3.85441 20.8968 4.80397 20.9904C4.90175 21 5.01783 21 5.25 21Z"/>' +
    '<path d="M16.5 7.49996C16.5 7.49996 13.1858 3.00001 12 3C10.8141 2.99999 7.5 7.5 7.5 7.5M12 4V15"/>',
} as const;

export type IconName = keyof typeof ICONS;

/** The icon `name`. Its size comes from the stylesheet (the element it sits in). */
export function icon(name: IconName): Html {
  return trusted(
    `<svg class="ink" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true">${ICONS[name]}</svg>`,
  );
}

/**
 * The mark of sevDesk MCP, as on the website and in `assets/logo.svg`: Summe, a capital sigma
 * from four bars of one thickness. The foot, the line under the sum, is the second piece and the
 * one in the accent (`.logo-foot`): what is booked below it is the person's decision. At the
 * wordmark's size the two pieces meet without a seam; the body reaches a hair under the foot,
 * which is drawn over it.
 */
export const MARK: Html = trusted(
  '<svg class="logo" viewBox="0 0 20.5 24" aria-hidden="true">' +
    '<path d="M0 0L20.5 0L20.5 4L9.66 4L17.66 12L9.66 20L9.66 20.4L0 24L12 12Z"/>' +
    '<path class="logo-foot" d="M0 24L9.66 20L20.5 20L20.5 24Z"/></svg>',
);
