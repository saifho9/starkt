export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export const snowflake = /^\d{17,20}$/;
export const objectId = /^[a-f\d]{24}$/i;
export function requireId(id, name = 'المعرّف') {
  if (typeof id !== 'string' || !snowflake.test(id)) throw new AppError(`${name} غير صالح.`);
  return id;
}
export function requirePanelId(id) {
  if (typeof id !== 'string' || !objectId.test(id)) throw new AppError('معرّف اللوحة غير صالح.');
  return id;
}
