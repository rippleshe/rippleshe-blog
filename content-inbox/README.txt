Rippleshe 内容收件箱

最舒服的方式：在项目目录运行 `pnpm studio`，打开 http://127.0.0.1:4175 ，拖入图片或文档。

也可以直接把图片 / PDF / Word / PPT / Excel / txt / md / zip 丢进这个文件夹，然后运行：

pnpm content:sync

图片会自动生成 WebP 与缩略图；文档保留原格式。已处理过的文件会按哈希跳过，不会重复收入。
