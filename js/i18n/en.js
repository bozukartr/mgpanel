/* Hotizy — English UI dictionary.
 *
 * Mirrors js/i18n/tr.js key-for-key. tests/i18n.test.js enforces that both
 * files carry exactly the same key set and the same {placeholders} — a
 * missing or drifted translation fails the build instead of silently
 * shipping Turkish text to an English-speaking guest.
 *
 * Hotel-authored content (catalog item names, restaurant menu, department
 * names, demo catalog data) is deliberately NOT here — that data belongs to
 * the hotel and is shown exactly as they entered it.
 */
window.I18N_EN = {
    // ── Common ───────────────────────────────────────────────────────────
    'guest.home.guestShort': 'Our Guest',
    'common.justNow': 'just now',
    'guest.gate.noConnectionDemo': 'Could not connect. You can test with ?demo.',
    'guest.gate.noConnectionRetry': 'Could not connect. Please try again.',
    'guest.track.noneInTab': 'No requests in this tab',
    'common.back': 'Back',
    'guest.services.title': 'Services',
    'guest.services.searchPlaceholder': 'Search services…',
    'guest.cart.title': 'My Cart',
    'guest.cart.clear': 'Clear',
    'guest.cart.goToCart': 'Go to cart',
    'guest.cart.countLabel': '{n} request(s)',
    'guest.home.legalNotice': 'By creating a request you agree to your data being processed for service purposes.',
    'guest.track.active': 'Your active requests',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.send': 'Send',
    'common.sending': 'Sending…',
    'common.edit': 'Edit',
    'common.select': 'Select',
    'common.all': 'All',
    'common.other': 'Other',
    'common.copied': 'Copied',
    'common.retry': 'Please try again.',
    'common.noConnection': 'Could not connect.',
    'common.people': 'guests',
    'common.minAgo': '{n} min ago',
    'common.hourAgo': '{n} h ago',

    // ── Guest · shell / navigation ───────────────────────────────────────
    'guest.title': 'Guest Services · Hotizy',
    'guest.nav.home': 'Home',
    'guest.nav.orders': 'My Requests',
    'guest.nav.chat': 'Chat',
    'guest.nav.profile': 'Profile',
    'guest.lang.switch': 'Language / Dil',

    // ── Guest · home ─────────────────────────────────────────────────────
    'guest.home.welcome': 'Welcome,',
    'guest.home.guestFallback': 'Dear Guest',
    'guest.home.greetMorning': 'Good morning,',
    'guest.home.greetEvening': 'Good evening,',
    'guest.home.quickActions': 'QUICK ACTIONS',
    'guest.home.subtitle': 'Enjoy your stay — everything you need is one tap away.',
    'guest.home.seeAllOrders': 'See all my requests',
    'guest.home.legal': 'Privacy Notice',

    // ── Guest · services ─────────────────────────────────────────────────
    'guest.services.howCanWeHelp': 'How can we help you?',
    'guest.services.notReady': 'Requests are not available for this hotel yet.',
    'guest.services.noResult': 'No results',
    'guest.services.noMatch': 'No service matches your search.',
    'guest.services.emptyCategory': 'No services in this category.',
    'guest.services.offHours': 'Outside hours',
    'guest.services.onlyBetween': 'This request is only available between {window}.',
    'guest.services.unavailableWindow': 'This service is only available between {window}.',

    // ── Guest · item sheet ───────────────────────────────────────────────
    'guest.item.quantity': 'Quantity',
    'guest.item.option': 'Option',
    'guest.item.customize': 'Customise',
    'guest.item.customizeHint': '(optional, you can pick more than one)',
    'guest.item.note': 'Note (optional)',
    'guest.item.notePlaceholder': 'e.g. 2 large towels',
    'guest.item.preferredTime': 'Preferred time (optional)',
    'guest.item.addToCart': 'Add to Cart',
    'guest.item.updateCart': 'Update Cart',
    'guest.item.removeFromCart': 'Remove from Cart',
    'guest.item.pickOption': 'Choose an option',
    'guest.item.pickOptionToast': 'Please choose an option.',
    'guest.item.added': 'Added to cart ✓',
    'guest.item.addedShort': 'Added to cart',
    'guest.item.removed': 'Removed from cart',
    'guest.item.maxDistinct': 'You can add up to {n} different requests.',
    'guest.item.maxQtyItem': 'Up to {n} of this request can be provided.',
    'guest.item.maxQtyGeneric': 'Up to {n} per request.',

    // ── Guest · transfer fields ──────────────────────────────────────────
    'guest.transfer.from': 'From',
    'guest.transfer.to': 'To',
    'guest.transfer.date': 'Date',
    'guest.transfer.time': 'Time',
    'guest.transfer.vehicle': 'Vehicle',
    'guest.transfer.fromPlaceholder': 'e.g. Hotel Lobby',
    'guest.transfer.toPlaceholder': 'e.g. Airport',
    'guest.transfer.vehiclePlaceholder': 'e.g. Minivan',
    'guest.transfer.needVehicle': 'Please enter the vehicle type.',
    'guest.transfer.needFrom': "Please enter the 'From' location.",
    'guest.transfer.needTo': "Please enter the 'To' location.",
    'guest.transfer.needDate': 'Please choose the transfer date.',
    'guest.transfer.needTime': 'Please choose the transfer time.',
    'guest.transfer.tooEarly': 'The earliest transfer time is {time} ({date}).',
    'guest.transfer.stale': 'The transfer time chosen for "{name}" has passed, please update it.',

    // ── Guest · cart ─────────────────────────────────────────────────────
    'guest.cart.empty': 'Your cart is empty',
    'guest.cart.emptyHint': 'Add a request from the Services tab.',
    'guest.cart.browse': 'Browse Services',
    'guest.cart.submit': 'Send Request',
    'guest.cart.submitted': 'Your request has been received! 🎉',
    'guest.cart.submittedDemo': 'Your request has been received! 🎉 (demo)',
    'guest.cart.failed': 'Could not send. Please try again.',
    'guest.cart.tooFast': 'Too fast! Please try again in {n} s.',
    'guest.cart.pendingExists': 'You already have a request awaiting approval. Please wait for it to be resolved 🙏',

    // ── Guest · request tracking ─────────────────────────────────────────
    'guest.track.none': 'No requests yet',
    'guest.track.noneHint': 'You can follow your requests live from here.',
    'guest.track.create': 'Create Request',
    'guest.track.createNew': 'Create New Request',
    'guest.track.yourRequests': 'YOUR REQUESTS',
    'guest.track.cancelItem': 'Cancel',
    'guest.track.cancelOrder': 'Cancel Request',
    'guest.track.confirmCancelItem': 'Are you sure you want to cancel this item?',
    'guest.track.confirmCancelOrder': 'Are you sure you want to cancel your request?',
    'guest.track.itemCancelled': 'Item cancelled.',
    'guest.track.orderCancelled': 'Your request has been cancelled.',
    'guest.track.cancelFailed': 'Could not cancel.',
    'guest.track.cancelFailedTaken': 'Could not cancel. A staff member has most likely already started it.',
    'guest.track.itemUpdated': 'Item updated ✓',
    'guest.track.updateFailedTaken': 'Could not update. A staff member has most likely already started it.',
    'guest.track.tabRequests': 'Requests',
    'guest.track.tabConcierge': 'Concierge',

    // ── Guest · order statuses ───────────────────────────────────────────
    'guest.status.pending': 'Pending',
    'guest.status.pendingSub': 'Your request has been sent to reception.',
    'guest.status.confirmed': 'Confirmed',
    'guest.status.confirmedSub': 'Your request is confirmed and being prepared.',
    'guest.status.inProgress': 'In progress',
    'guest.status.inProgressSub': 'Our team is preparing your request.',
    'guest.status.completed': 'Completed',
    'guest.status.completedSub': 'Your request is complete. Thank you!',
    'guest.status.cancelled': 'Cancelled',
    'guest.status.cancelledSub': 'This request has been cancelled.',

    // ── Guest · identity verification ────────────────────────────────────
    'guest.gate.title': 'Let us verify you',
    'guest.gate.sub': 'To create a request, confirm the <b>surname</b> and <b>year of birth</b> on your booking.',
    'guest.gate.surname': 'Surname',
    'guest.gate.surnamePlaceholder': 'e.g. SMITH',
    'guest.gate.birthYear': 'Year of birth',
    'guest.gate.birthYearPlaceholder': 'e.g. 1990',
    'guest.gate.submit': 'Verify and Continue',
    'guest.gate.help': 'Having trouble? Please contact reception.',
    'guest.gate.needSurname': 'Please enter your surname.',
    'guest.gate.needBirthYear': 'Please enter a valid year of birth.',
    'guest.gate.mismatch': 'Surname and year of birth did not match. Please contact reception.',
    'guest.gate.failed': 'Verification failed. Please try again.',
    'guest.gate.expired': 'Your session has expired. Please verify again with your surname and year of birth — your cart is safe.',
    'guest.gate.verified': 'Verified 👋',
    'guest.gate.required': 'Verification required',
    'guest.gate.requiredHint': 'To see your stay details, please first verify with your surname and year of birth.',

    // ── Guest · hotel info ───────────────────────────────────────────────
    'guest.info.title': 'Hotel Information',
    'guest.info.none': 'No information',
    'guest.info.noneHint': 'No hotel information has been added yet.',
    'guest.info.reception': 'Reception',
    'guest.info.wifiName': 'Wi-Fi network',
    'guest.info.wifiPass': 'Wi-Fi password',
    'guest.info.checkout': 'Check-out',
    'guest.info.breakfast': 'Breakfast',
    'guest.info.address': 'Address',
    'guest.info.copy': 'Copy',
    'guest.info.receptionHint': 'Our reception team is at your service. Reach us below or create a request quickly.',

    // ── Guest · menus ────────────────────────────────────────────────────
    'guest.menus.title': 'Menus',
    'guest.menus.none': 'No menus',
    'guest.menus.noneHint': 'No menu has been added for this hotel yet.',
    'guest.menus.noLink': 'No link is defined for this menu.',

    // ── Guest · stay / room account ──────────────────────────────────────
    'guest.stay.title': 'Your Stay',
    'guest.stay.checkIn': 'Check-in',
    'guest.stay.checkOut': 'Check-out',
    'guest.stay.folio': 'My Room Account',
    'guest.stay.folioShort': 'Room Account',
    'guest.stay.reservations': 'My Reservations',
    'guest.stay.noReservations': 'No reservations on file.',
    'guest.stay.noDetail': 'No details',
    'guest.stay.noItems': 'No items',
    'guest.stay.loadFailed': 'Could not load information',
    'guest.stay.configError': 'Configuration error',

    // ── Guest · rating ───────────────────────────────────────────────────

    // ── Guest · department cards ─────────────────────────────────────────
    'guest.dept.housekeeping': 'Cleaning, towels, amenities and more.',
    'guest.dept.engineering': 'Let us fix technical issues quickly.',
    'guest.dept.concierge': 'The details that make your stay a pleasure.'
};
