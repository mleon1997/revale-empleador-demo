import initHandler from "./revale-db-init.js";

export default async function handler(req, res) {
  req.method = "POST";
  return initHandler(req, res);
}
