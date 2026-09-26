/**
 * What the POS can drive (spec §15). Shown on the Hardware page so stores know
 * what to buy. Scales and fiscal printers are not supported yet: the flags say so
 * instead of pretending.
 */
export interface HardwareCapability {
  key: string;
  supported: boolean;
  // How it is driven, or why it is not
  via: string;
}

export const HARDWARE_CAPABILITIES: HardwareCapability[] = [
  {
    key: 'receipt_printer',
    supported: true,
    via: 'ESC/POS network printers (TCP 9100) through the print bridge; any printer through the browser print dialog',
  },
  {
    key: 'cash_drawer',
    supported: true,
    via: 'Drawer kick through the receipt printer (print bridge); never replayed automatically',
  },
  {
    key: 'barcode_scanner',
    supported: true,
    via: 'USB/Bluetooth scanners in keyboard mode; timing and terminator set per till',
  },
  {
    key: 'customer_display',
    supported: true,
    via: 'Second browser window on /customer-display (same PC, no server)',
  },
  {
    key: 'usb_printer',
    supported: false,
    via: 'Optional in the print bridge with the escpos-usb package (not installed by default)',
  },
  { key: 'scale', supported: false, via: 'Not supported yet' },
  { key: 'fiscal_printer', supported: false, via: 'Not supported yet' },
  {
    key: 'card_terminal',
    supported: false,
    via: 'Handled by the payment provider integration',
  },
];
