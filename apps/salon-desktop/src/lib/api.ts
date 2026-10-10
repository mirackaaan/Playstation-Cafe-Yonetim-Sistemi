import { invoke } from "@tauri-apps/api/core";
import type { Device, DeviceStatus } from "@cave/shared";

export const salonApi = {
  listDevices: () => invoke<Device[]>("list_devices"),
  addDevice: (name: string) => invoke<Device>("add_device", { name }),
  updateStatus: (deviceId: number, status: DeviceStatus) => invoke<Device>("update_device_status", { deviceId, status }),
  startSession: (deviceId: number) => invoke<Device>("start_session", { deviceId }),
  stopSession: (deviceId: number) => invoke<Device>("stop_session", { deviceId }),
  getHourlyRate: () => invoke<number>("get_hourly_rate"),
  setHourlyRate: (hourlyRate: number) => invoke<number>("set_hourly_rate", { hourlyRate }),
};
